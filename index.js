require("dotenv").config();

const express = require("express");
const https = require("https");
const crypto = require("crypto");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} = require("discord.js");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const GOLD = 0xD4AF37;
const SHOP_ID = process.env.SELLAUTH_SHOP_ID || "275335";
const SHOP_URL = "https://simba-market.mysellauth.com/";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

app.use(express.json({ limit: "1mb" }));

const processedOrders = new Set();
const processedDeliveries = new Set();

function remember(set, value, limit = 2000) {
  set.add(String(value));
  if (set.size > limit) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

function firstDefined(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function safeText(value, fallback = "Not available") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "object") {
    return JSON.stringify(value).slice(0, 1000);
  }

  return String(value).slice(0, 1000);
}

function formatMoney(value, currency) {
  if (value === undefined || value === null || value === "") {
    return "Not available";
  }

  const amount =
    typeof value === "object"
      ? firstDefined(value.amount, value.value, value.price)
      : value;

  if (amount === undefined || amount === null) {
    return "Not available";
  }

  return `${amount}${currency ? ` ${currency}` : ""}`;
}

function getEventName(payload, req) {
  return String(
    firstDefined(
      payload.event,
      payload.type,
      payload.event_type,
      req.headers["x-sellauth-event"],
      req.headers["x-webhook-event"],
      ""
    )
  ).toLowerCase();
}

function getDeliveryId(payload, req) {
  return firstDefined(
    req.headers["x-sellauth-delivery"],
    req.headers["x-webhook-id"],
    payload.delivery_id,
    payload.idempotency_key
  );
}

function collectObjects(value, result = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return result;
  }

  if (!result.includes(value)) {
    result.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjects(item, result, depth + 1);
    }
  } else {
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        collectObjects(child, result, depth + 1);
      }
    }
  }

  return result;
}

function findDeepValue(source, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));

  for (const obj of collectObjects(source)) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        wanted.has(key.toLowerCase()) &&
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        return value;
      }
    }
  }

  return undefined;
}

function getProductId(payload) {
  return firstDefined(
    findDeepValue(payload, ["product_id", "productId"]),
    payload?.data?.product?.id,
    payload?.product?.id
  );
}

function findProductName(payload) {
  return firstDefined(
    findDeepValue(payload, [
      "product_name",
      "productName",
      "product_title",
      "productTitle",
      "name",
      "title",
    ])
  );
}

function findProductUrl(payload) {
  const value = firstDefined(
    findDeepValue(payload, [
      "product_url",
      "productUrl",
      "product_link",
      "productLink",
      "checkout_url",
      "checkoutUrl",
      "url",
    ]),
    SHOP_URL
  );

  const url = String(value);

  return /^https:\/\/[^\s]+$/i.test(url) ? url : SHOP_URL;
}

function findImage(payload) {
  const value = findDeepValue(payload, [
    "image_url",
    "imageUrl",
    "thumbnail",
    "image",
  ]);

  if (typeof value !== "string") return undefined;

  return /^https:\/\/[^\s]+$/i.test(value)
    ? value
    : undefined;
}

/*
 * SellAuth product API.
 * The API documentation shows GET with a JSON request body.
 * https.request permits sending that body with GET.
 */
function sellAuthRequest(path, body) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.SELLAUTH_API_KEY;

    if (!apiKey) {
      return reject(new Error("SELLAUTH_API_KEY is missing."));
    }

    const data = body ? JSON.stringify(body) : "";

    const request = https.request(
      {
        hostname: "api.sellauth.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: 15000,
      },
      (response) => {
        let responseBody = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });

        response.on("end", () => {
          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            return reject(
              new Error(
                `SellAuth API returned HTTP ${response.statusCode}: ` +
                  responseBody.slice(0, 500)
              )
            );
          }

          try {
            resolve(
              responseBody ? JSON.parse(responseBody) : {}
            );
          } catch {
            reject(
              new Error("SellAuth API returned invalid JSON.")
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("SellAuth API request timed out."));
    });

    request.on("error", reject);

    if (data) request.write(data);

    request.end();
  });
}

function normalizeProducts(result) {
  if (Array.isArray(result)) return result;

  if (Array.isArray(result?.products)) return result.products;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.data?.products)) {
    return result.data.products;
  }

  return [];
}

async function getSellAuthProduct(productId) {
  if (!productId) return null;

  const result = await sellAuthRequest(
    `/v1/shops/${encodeURIComponent(SHOP_ID)}/products`,
    {
      page: 1,
      perPage: 100,
      ids: [Number(productId)],
      orderColumn: null,
      orderDirection: null,
      type: null,
      paths: null,
      name: null,
      variant_name: null,
      sku: null,
      visibilities: null,
      group_ids: null,
      group_null: null,
      badge_text: null,
      status_text: null,
      deliverable: null,
      deliverables_type: null,
      all: null,
    }
  );

  const products = normalizeProducts(result);

  const product = products.find(
    (item) => Number(item.id) === Number(productId)
  );

  if (!product) {
    console.log(
      `SellAuth API did not return product ID ${productId}.`
    );
    return null;
  }

  return product;
}

function getApiProductStock(product) {
  if (!product) return undefined;

  const directStock = firstDefined(
    product.stock,
    product.current_stock,
    product.currentStock,
    product.stock_quantity,
    product.stockQuantity,
    product.quantity_available,
    product.quantityAvailable,
    product.inventory_quantity,
    product.inventoryQuantity
  );

  if (directStock !== undefined) return directStock;

  const variants = Array.isArray(product.variants)
    ? product.variants
    : [];

  if (variants.length === 1) {
    const variant = variants[0];

    return firstDefined(
      variant.stock,
      variant.current_stock,
      variant.currentStock,
      variant.stock_quantity,
      variant.stockQuantity,
      variant.quantity_available,
      variant.quantityAvailable,
      variant.inventory_quantity,
      variant.inventoryQuantity
    );
  }

  return undefined;
}

function buildRestockEmbed(payload, apiProduct = null) {
  const webhookName = findProductName(payload);

  const name = firstDefined(
    apiProduct?.name,
    apiProduct?.title,
    apiProduct?.product_name,
    webhookName
  );

  const webhookVariant = findDeepValue(payload, [
    "variant_name",
    "variantName",
    "variant_title",
    "variantTitle",
  ]);

  const variants = Array.isArray(apiProduct?.variants)
    ? apiProduct.variants
    : [];

  const variant = firstDefined(
    webhookVariant,
    variants.length === 1 ? variants[0].name : undefined,
    variants.length === 1 ? variants[0].title : undefined,
    "Default"
  );

  const price = firstDefined(
    apiProduct?.price,
    apiProduct?.unit_price,
    apiProduct?.unitPrice,
    apiProduct?.price_amount,
    apiProduct?.priceAmount,
    findDeepValue(payload, [
      "unit_price",
      "unitPrice",
      "price_amount",
      "priceAmount",
      "price",
    ])
  );

  const currency = firstDefined(
    apiProduct?.currency,
    apiProduct?.currency_code,
    apiProduct?.currencyCode,
    findDeepValue(payload, [
      "currency",
      "currency_code",
      "currencyCode",
    ])
  );

  const stock = firstDefined(
    getApiProductStock(apiProduct),
    findDeepValue(payload, [
      "current_stock",
      "currentStock",
      "stock_quantity",
      "stockQuantity",
      "quantity_available",
      "quantityAvailable",
      "new_stock",
      "newStock",
      "new_quantity",
      "newQuantity",
      "inventory_quantity",
      "inventoryQuantity",
      "stock",
      "inventory",
      "available",
    ])
  );

  const productUrl = firstDefined(
    apiProduct?.url,
    apiProduct?.product_url,
    apiProduct?.productUrl,
    findProductUrl(payload),
    SHOP_URL
  );

  const url =
    typeof productUrl === "string" &&
    /^https:\/\/[^\s]+$/i.test(productUrl)
      ? productUrl
      : SHOP_URL;

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("🦁 SIMBA SHOP | Stock Replenished")
    .setDescription("A product's stock has been updated!")
    .addFields(
      {
        name: "Product",
        value: safeText(name),
        inline: false,
      },
      {
        name: "Variant",
        value: safeText(variant, "Default"),
        inline: true,
      },
      {
        name: "Price",
        value: formatMoney(price, currency),
        inline: true,
      },
      {
        name: "Current Stock",
        value: safeText(stock),
        inline: true,
      },
      {
        name: "Purchase",
        value: `[Click here to purchase](${url})`,
        inline: false,
      }
    )
    .setURL(url)
    .setFooter({
      text: "🦁 SIMBA SHOP • Powered by SellAuth",
    })
    .setTimestamp();

  const image = firstDefined(
    apiProduct?.image_url,
    apiProduct?.imageUrl,
    apiProduct?.image,
    findImage(payload)
  );

  if (
    typeof image === "string" &&
    /^https:\/\/[^\s]+$/i.test(image)
  ) {
    embed.setThumbnail(image);
  }

  return embed;
}

function getOrder(payload) {
  return firstDefined(
    payload?.data?.order,
    payload?.order,
    payload?.data,
    payload
  );
}

function buildSaleEmbed(payload) {
  const order = getOrder(payload);
  const productName = firstDefined(
    findProductName(payload),
    findDeepValue(order, ["name", "title"]),
    "Digital product"
  );

  const orderId = firstDefined(
    order?.id,
    order?.order_id,
    order?.uuid,
    payload?.order_id,
    "Not available"
  );

  const price = findDeepValue(order, [
    "total",
    "total_price",
    "totalPrice",
    "amount",
    "price",
  ]);

  const currency = findDeepValue(order, [
    "currency",
    "currency_code",
    "currencyCode",
  ]);

  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("🦁 SIMBA SHOP | New Sale")
    .setDescription("A new order has been received!")
    .addFields(
      {
        name: "Product",
        value: safeText(productName),
        inline: false,
      },
      {
        name: "Order ID",
        value: safeText(orderId),
        inline: true,
      },
      {
        name: "Total",
        value: formatMoney(price, currency),
        inline: true,
      },
      {
        name: "Store",
        value: `[Open SIMBA SHOP](${SHOP_URL})`,
        inline: false,
      }
    )
    .setURL(SHOP_URL)
    .setFooter({
      text: "🦁 SIMBA SHOP • Powered by SellAuth",
    })
    .setTimestamp();
}

async function sendToChannel(channelId, message) {
  if (!channelId) {
    throw new Error("Channel ID is missing in Railway Variables.");
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel ${channelId} is not a text channel.`);
  }

  return channel.send(message);
}

function makeTestSaleEmbed() {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("🦁 SIMBA SHOP | Test Sale")
    .setDescription("This is a test sale notification.")
    .addFields(
      { name: "Product", value: "Test product", inline: true },
      { name: "Total", value: "5 USD", inline: true },
      { name: "Order ID", value: "TEST-ORDER", inline: true }
    )
    .setFooter({ text: "🦁 SIMBA SHOP • Test" })
    .setTimestamp();
}

function makeTestStockEmbed() {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("🦁 SIMBA SHOP | Stock Replenished")
    .setDescription("This is a test stock notification.")
    .addFields(
      { name: "Product", value: "Test product", inline: false },
      { name: "Variant", value: "Default", inline: true },
      { name: "Price", value: "5 USD", inline: true },
      { name: "Current Stock", value: "24", inline: true },
      {
        name: "Purchase",
        value: `[Click here to purchase](${SHOP_URL})`,
        inline: false,
      }
    )
    .setURL(SHOP_URL)
    .setFooter({ text: "🦁 SIMBA SHOP • Test" })
    .setTimestamp();
}

const commands = [
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a message to a selected channel.")
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("The channel where the message will be sent.")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("mensaje")
        .setDescription("The message to send.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("testventa")
    .setDescription("Send a test sale notification."),

  new SlashCommandBuilder()
    .setName("teststock")
    .setDescription("Send a test stock notification."),
].map((command) => command.toJSON());

client.once("ready", async () => {
  console.log(`Discord connected as ${client.user.tag}`);

  try {
    const rest = new REST({ version: "10" }).setToken(
      process.env.DISCORD_TOKEN
    );

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Failed to register slash commands:", error.message);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "say") {
      const allowedUserId = process.env.SAY_ALLOWED_USER_ID;

      if (
        allowedUserId &&
        interaction.user.id !== allowedUserId
      ) {
        return interaction.reply({
          content: "You are not allowed to use this command.",
          ephemeral: true,
        });
      }

      const channel = interaction.options.getChannel("canal");
      const message = interaction.options.getString("mensaje");

      if (!channel || !channel.isTextBased()) {
        return interaction.reply({
          content: "Please select a text channel.",
          ephemeral: true,
        });
      }

      await channel.send({ content: message });

      return interaction.reply({
        content: `Message sent to ${channel}.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "testventa") {
      await interaction.deferReply({ ephemeral: true });

      await sendToChannel(process.env.SALES_CHANNEL_ID, {
        embeds: [makeTestSaleEmbed()],
        allowedMentions: { parse: [] },
      });

      return interaction.editReply("Test sale notification sent.");
    }

    if (interaction.commandName === "teststock") {
      await interaction.deferReply({ ephemeral: true });

      await sendToChannel(process.env.RESTOCK_CHANNEL_ID, {
        content: "@everyone",
        embeds: [makeTestStockEmbed()],
        allowedMentions: { parse: ["everyone"] },
      });

      return interaction.editReply("Test stock notification sent.");
    }
  } catch (error) {
    console.error("Command error:", error);

    const message = "The command failed. Check Railway logs.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

app.get("/", (_req, res) => {
  res.status(200).send("SIMBA SHOP Discord bot is online.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/webhooks/sellauth", async (req, res) => {
  const expectedToken = process.env.SELLAUTH_WEBHOOK_TOKEN;
  const receivedToken = req.query.token;

  if (!expectedToken) {
    return res.status(401).json({
      ok: false,
      error: "Webhook authentication is not configured.",
    });
  }

  if (
    typeof receivedToken !== "string" ||
    receivedToken.length !== expectedToken.length ||
    !crypto.timingSafeEqual(
      Buffer.from(receivedToken),
      Buffer.from(expectedToken)
    )
  ) {
    return res.status(401).json({
      ok: false,
      error: "Invalid webhook token.",
    });
  }

  const payload = req.body;

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON payload.",
    });
  }

  const event = getEventName(payload, req);
  const deliveryId = getDeliveryId(payload, req);

  console.log("SellAuth event received:", event || "(no event name)");
  console.log(
    "SellAuth payload top-level keys:",
    Object.keys(payload).join(", ")
  );

  if (deliveryId && processedDeliveries.has(deliveryId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  try {
    const stockEvent =
      event.includes("stock") ||
      event.includes("restock") ||
      event.includes("inventory");

    const saleEvent =
      !stockEvent &&
      (
        event.includes("sale") ||
        event.includes("order") ||
        event.includes("payment") ||
        event.includes("paid") ||
        event.includes("completed") ||
        event.includes("complete")
      );

    if (stockEvent) {
      const productId = getProductId(payload);
      let apiProduct = null;

      if (productId) {
        try {
          apiProduct = await getSellAuthProduct(productId);

          console.log(
            "SellAuth product lookup:",
            JSON.stringify({
              requestedProductId: productId,
              found: Boolean(apiProduct),
              returnedProductId: apiProduct?.id ?? null,
              hasName: Boolean(apiProduct?.name || apiProduct?.title),
              hasPrice: apiProduct?.price !== undefined,
              hasStock: getApiProductStock(apiProduct) !== undefined,
            })
          );
        } catch (error) {
          console.error(
            "SellAuth product lookup failed:",
            error.message
          );
        }
      } else {
        console.log("Restock webhook did not include a product ID.");
      }

      await sendToChannel(process.env.RESTOCK_CHANNEL_ID, {
        content: "@everyone",
        embeds: [buildRestockEmbed(payload, apiProduct)],
        allowedMentions: { parse: ["everyone"] },
      });

      console.log("Restock embed sent successfully.");
    } else if (saleEvent) {
      const order = getOrder(payload);
      const orderId = firstDefined(
        order?.id,
        order?.order_id,
        order?.uuid,
        payload?.order_id
      );

      if (orderId && processedOrders.has(String(orderId))) {
        if (deliveryId) remember(processedDeliveries, deliveryId);

        return res.status(200).json({
          ok: true,
          duplicate: true,
        });
      }

      await sendToChannel(process.env.SALES_CHANNEL_ID, {
        embeds: [buildSaleEmbed(payload)],
        allowedMentions: { parse: [] },
      });

      if (orderId) remember(processedOrders, String(orderId));

      console.log("Sale embed sent successfully.");
    } else {
      console.log("Unrecognized SellAuth event:", event || "(no event name)");
    }

    if (deliveryId) remember(processedDeliveries, deliveryId);

    return res.status(200).json({
      ok: true,
      event: event || "unknown",
    });
  } catch (error) {
    console.error("Webhook processing error:", error);

    return res.status(500).json({
      ok: false,
      error: "Failed to process webhook.",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN.");
  process.exit(1);
}

if (!process.env.CLIENT_ID || !process.env.GUILD_ID) {
  console.error("Missing CLIENT_ID or GUILD_ID.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Discord login failed:", error);
  process.exit(1);
});
