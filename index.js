
require("dotenv").config();

const express = require("express");
const https = require("https");
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
const PORT = Number(process.env.PORT || 3000);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const SAY_ALLOWED_USER_ID = process.env.SAY_ALLOWED_USER_ID;
const SALES_CHANNEL_ID = process.env.SALES_CHANNEL_ID;
const RESTOCK_CHANNEL_ID = process.env.RESTOCK_CHANNEL_ID;

const SELLAUTH_API_KEY = process.env.SELLAUTH_API_KEY;
const SELLAUTH_WEBHOOK_TOKEN = process.env.SELLAUTH_WEBHOOK_TOKEN;
const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID || "275335";

const STORE_URL = "https://simba-market.mysellauth.com/";
const GOLD = 0xd4af37;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function firstDefined(...values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ""
  );
}

function formatMoney(value, currency) {
  if (value === undefined || value === null || value === "") {
    return "Not available";
  }

  if (typeof value === "object") {
    value = firstDefined(
      value.amount,
      value.value,
      value.price,
      value.total
    );
  }

  if (value === undefined || value === null || value === "") {
    return "Not available";
  }

  const amount = Number(value);
  const formatted = Number.isFinite(amount)
    ? amount.toFixed(2)
    : String(value);

  return currency
    ? `${formatted} ${currency}`
    : formatted;
}

function getNestedValue(object, paths) {
  for (const path of paths) {
    const value = path
      .split(".")
      .reduce(
        (current, key) =>
          current && current[key] !== undefined
            ? current[key]
            : undefined,
        object
      );

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function findProductObject(data, productId) {
  if (!data) return null;

  if (Array.isArray(data)) {
    return (
      data.find(
        (item) =>
          String(
            firstDefined(item.id, item.product_id, item.productId, "")
          ) === String(productId)
      ) || null
    );
  }

  if (typeof data !== "object") return null;

  if (
    String(
      firstDefined(data.id, data.product_id, data.productId, "")
    ) === String(productId)
  ) {
    return data;
  }

  for (const key of ["data", "product", "products", "results", "items"]) {
    if (data[key]) {
      const found = findProductObject(data[key], productId);
      if (found) return found;
    }
  }

  return null;
}

function getProductName(payload, apiProduct) {
  return (
    firstDefined(
      getNestedValue(payload, [
        "data.product.name",
        "data.product_name",
        "data.productName",
        "data.name",
        "product.name",
        "product_name",
        "productName",
      ]),
      apiProduct?.name,
      apiProduct?.title,
      "Unknown product"
    )
  );
}

function getProductId(payload) {
  return firstDefined(
    payload?.data?.product_id,
    payload?.data?.productId,
    payload?.product_id,
    payload?.productId,
    payload?.data?.product?.id,
    payload?.product?.id
  );
}

function getWebhookVariant(payload) {
  return firstDefined(
    payload?.data?.variant,
    payload?.data?.product_variant,
    payload?.data?.productVariant,
    payload?.data?.variant_name,
    payload?.data?.variantName,
    payload?.variant,
    payload?.variant_name,
    payload?.variantName
  );
}

function getVariantName(variant) {
  if (variant === undefined || variant === null) return undefined;

  if (typeof variant === "string" || typeof variant === "number") {
    return String(variant);
  }

  return firstDefined(
    variant.name,
    variant.title,
    variant.label,
    variant.id,
    variant.variant_id,
    variant.variantId
  );
}

function getVariants(apiProduct) {
  const variants = firstDefined(
    apiProduct?.variants,
    apiProduct?.product_variants,
    apiProduct?.productVariants,
    apiProduct?.options
  );

  if (Array.isArray(variants)) return variants;

  if (variants && typeof variants === "object") {
    return Object.values(variants);
  }

  return [];
}

function findMatchingVariant(payload, apiProduct) {
  const variants = getVariants(apiProduct);
  if (!variants.length) return null;

  const webhookVariant = getWebhookVariant(payload);
  const webhookVariantName = getVariantName(webhookVariant);

  const variantIds = [
    payload?.data?.variant_id,
    payload?.data?.variantId,
    payload?.data?.variant?.id,
    payload?.data?.variant?.variant_id,
    payload?.data?.restocked_variant_ids?.[0],
    payload?.variant_id,
    payload?.variantId,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map(String);

  if (variantIds.length) {
    const byId = variants.find((variant) =>
      variantIds.includes(
        String(
          firstDefined(
            variant.id,
            variant.variant_id,
            variant.variantId,
            ""
          )
        )
      )
    );

    if (byId) return byId;
  }

  if (webhookVariantName) {
    const target = String(webhookVariantName).toLowerCase();

    const byName = variants.find((variant) => {
      const name = String(
        firstDefined(variant.name, variant.title, variant.label, "")
      ).toLowerCase();

      return name === target;
    });

    if (byName) return byName;
  }

  return variants.length === 1 ? variants[0] : null;
}

// --------------------------------------------------
// SELLAUTH API
// --------------------------------------------------

function sellAuthRequest(path) {
  return new Promise((resolve, reject) => {
    if (!SELLAUTH_API_KEY) {
      return reject(new Error("SELLAUTH_API_KEY is not configured"));
    }

    const request = https.request(
      {
        hostname: "api.sellauth.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${SELLAUTH_API_KEY}`,
          Accept: "application/json",
        },
        timeout: 10000,
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            return reject(
              new Error(
                `SellAuth API returned HTTP ${response.statusCode}: ${body.slice(0, 300)}`
              )
            );
          }

          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            reject(new Error("SellAuth API returned invalid JSON"));
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("SellAuth API request timed out"));
    });

    request.on("error", reject);
    request.end();
  });
}

async function getSellAuthProduct(productId) {
  if (!productId) return null;

  const path =
    `/v1/shops/${encodeURIComponent(SELLAUTH_SHOP_ID)}/products`;

  const response = await sellAuthRequest(path);
  return findProductObject(response, productId);
}

// --------------------------------------------------
// EMBEDS
// --------------------------------------------------

function buildSaleEmbed(payload) {
  const data = payload?.data || payload;

  const productName = firstDefined(
    data?.product?.name,
    data?.product_name,
    data?.productName,
    data?.name,
    "Digital product"
  );

  const orderId = firstDefined(
    data?.order_id,
    data?.orderId,
    data?.invoice_id,
    data?.invoiceId,
    data?.id
  );

  const amount = firstDefined(
    data?.total,
    data?.amount,
    data?.price,
    data?.total_amount,
    data?.totalAmount,
    data?.payment?.amount
  );

  const currency = firstDefined(
    data?.currency,
    data?.payment?.currency,
    "EUR"
  );

  const buyer = firstDefined(
    data?.customer?.username,
    data?.customer?.name,
    data?.customer_name,
    data?.customerName,
    data?.email,
    data?.customer?.email
  );

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("🦁 SIMBA SHOP • New Order")
    .setDescription("A new order has been received!")
    .addFields(
      {
        name: "Product",
        value: String(productName).slice(0, 1024),
        inline: true,
      },
      {
        name: "Amount",
        value: formatMoney(amount, currency),
        inline: true,
      }
    )
    .setURL(STORE_URL)
    .setTimestamp()
    .setFooter({ text: "🦁 SIMBA SHOP • SellAuth" });

  if (orderId !== undefined) {
    embed.addFields({
      name: "Order ID",
      value: String(orderId).slice(0, 1024),
      inline: true,
    });
  }

  if (buyer) {
    embed.addFields({
      name: "Customer",
      value: String(buyer).slice(0, 1024),
      inline: true,
    });
  }

  return embed;
}

function buildRestockEmbed(payload, apiProduct = null) {
  const productId = getProductId(payload);
  const webhookVariant = getWebhookVariant(payload);
  const matchingVariant = findMatchingVariant(payload, apiProduct);

  const productName = getProductName(payload, apiProduct);

  const variantName = firstDefined(
    getVariantName(webhookVariant),
    matchingVariant?.name,
    matchingVariant?.title,
    matchingVariant?.label
  );

  const price = firstDefined(
    matchingVariant?.price,
    matchingVariant?.unit_price,
    matchingVariant?.unitPrice,
    matchingVariant?.price_amount,
    matchingVariant?.priceAmount,
    matchingVariant?.amount,
    matchingVariant?.value,
    apiProduct?.price,
    apiProduct?.unit_price,
    apiProduct?.unitPrice,
    apiProduct?.price_amount,
    apiProduct?.priceAmount,
    apiProduct?.amount,
    payload?.data?.price,
    payload?.data?.amount,
    payload?.price,
    payload?.amount
  );

  const currency = firstDefined(
    matchingVariant?.currency,
    matchingVariant?.price_currency,
    matchingVariant?.priceCurrency,
    apiProduct?.currency,
    apiProduct?.price_currency,
    apiProduct?.priceCurrency,
    payload?.data?.currency,
    payload?.currency,
    "EUR"
  );

  const stock = firstDefined(
    matchingVariant?.stock,
    matchingVariant?.quantity,
    matchingVariant?.stock_count,
    matchingVariant?.stockCount,
    apiProduct?.stock,
    apiProduct?.quantity,
    apiProduct?.stock_count,
    apiProduct?.stockCount,
    payload?.data?.stock,
    payload?.data?.quantity,
    payload?.stock,
    payload?.quantity
  );

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("📦 SIMBA SHOP • Restock")
    .setDescription("A product has been restocked!")
    .addFields(
      {
        name: "Product",
        value: String(productName).slice(0, 1024),
        inline: true,
      },
      {
        name: "Price",
        value: formatMoney(price, currency),
        inline: true,
      },
      {
        name: "Current Stock",
        value: stock !== undefined ? String(stock) : "Not available",
        inline: true,
      }
    )
    .setURL(STORE_URL)
    .setTimestamp()
    .setFooter({ text: "🦁 SIMBA SHOP • SellAuth" });

  if (variantName) {
    embed.addFields({
      name: "Variant",
      value: String(variantName).slice(0, 1024),
      inline: true,
    });
  }

  if (productId !== undefined) {
    embed.addFields({
      name: "Product ID",
      value: String(productId),
      inline: true,
    });
  }

  return embed;
}

// --------------------------------------------------
// DISCORD CHANNEL HELPERS
// --------------------------------------------------

async function sendToChannel(channelId, message) {
  if (!channelId) {
    throw new Error("The destination channel ID is not configured");
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased() || !channel.send) {
    throw new Error("The configured destination is not a text channel");
  }

  return channel.send(message);
}

// --------------------------------------------------
// SLASH COMMANDS
// --------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a message to a selected channel")
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Channel where the message will be sent")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("mensaje")
        .setDescription("Message to send")
        .setRequired(true)
        .setMaxLength(2000)
    ),

  new SlashCommandBuilder()
    .setName("testventa")
    .setDescription("Test the SIMBA SHOP sale notification"),

  new SlashCommandBuilder()
    .setName("teststock")
    .setDescription("Test the SIMBA SHOP restock notification"),
].map((command) => command.toJSON());

// --------------------------------------------------
// REGISTER COMMANDS
// --------------------------------------------------

async function registerCommands() {
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error(
      "Missing required variables: DISCORD_TOKEN, CLIENT_ID or GUILD_ID"
    );
    return;
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Discord slash commands registered.");
}

// --------------------------------------------------
// DISCORD EVENTS
// --------------------------------------------------

client.once("ready", () => {
  console.log(`SIMBA SHOP online as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "say") {
      if (
        SAY_ALLOWED_USER_ID &&
        interaction.user.id !== SAY_ALLOWED_USER_ID
      ) {
        return interaction.reply({
          content: "You are not allowed to use this command.",
          ephemeral: true,
        });
      }

      const channel = interaction.options.getChannel("canal");
      const message = interaction.options.getString("mensaje", true);

      if (!channel || !channel.isTextBased() || !channel.send) {
        return interaction.reply({
          content: "Please select a text channel.",
          ephemeral: true,
        });
      }

      await channel.send({ content: message });

      return interaction.reply({
        content: "Message sent successfully.",
        ephemeral: true,
      });
    }

    if (interaction.commandName === "testventa") {
      await interaction.deferReply({ ephemeral: true });

      const embed = new EmbedBuilder()
        .setColor(GOLD)
        .setTitle("🦁 SIMBA SHOP • New Order")
        .setDescription("This is a test sale notification.")
        .addFields(
          { name: "Product", value: "Test product", inline: true },
          { name: "Amount", value: "1.00 EUR", inline: true },
          { name: "Order ID", value: "TEST-001", inline: true }
        )
        .setURL(STORE_URL)
        .setTimestamp()
        .setFooter({ text: "🦁 SIMBA SHOP • SellAuth" });

      await sendToChannel(SALES_CHANNEL_ID, { embeds: [embed] });

      return interaction.editReply("Test sale notification sent.");
    }

    if (interaction.commandName === "teststock") {
      await interaction.deferReply({ ephemeral: true });

      const testPayload = {
        event: "notification.shop_product_restocked",
        shop_id: SELLAUTH_SHOP_ID,
        data: {
          product_id: 913357,
          product_name: "Test product",
          variant_name: "Test variant",
          price: 1,
          currency: "EUR",
          stock: 24,
        },
      };

      const embed = buildRestockEmbed(testPayload);

      await sendToChannel(RESTOCK_CHANNEL_ID, { embeds: [embed] });

      return interaction.editReply("Test restock notification sent.");
    }
  } catch (error) {
    console.error("Command error:", error);

    const message = "An error occurred. Check the Railway logs.";

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

// --------------------------------------------------
// SELLAUTH WEBHOOK
// --------------------------------------------------

app.post("/webhooks/sellauth", async (req, res) => {
  // Optional shared-token verification.
  // Configure SELLAUTH_WEBHOOK_TOKEN in Railway and use the same
  // token in the SellAuth webhook URL:
  // /webhooks/sellauth?token=YOUR_SECRET
  if (
    SELLAUTH_WEBHOOK_TOKEN &&
    req.query.token !== SELLAUTH_WEBHOOK_TOKEN
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body || {};
  const event = String(
    firstDefined(payload.event, payload.type, payload.name, "")
  ).toLowerCase();

  console.log("SellAuth webhook received:", event || "(event not specified)");
  console.log("SellAuth webhook keys:", Object.keys(payload));

  // Respond immediately so the webhook sender does not have to wait
  // for Discord or the SellAuth API lookup.
  res.status(200).json({ received: true });

  try {
    const isRestock =
      event.includes("restock") ||
      event.includes("stock");

    const isSale =
      event.includes("sale") ||
      event.includes("order") ||
      event.includes("payment") ||
      event.includes("invoice");

    if (isRestock) {
      const productId = getProductId(payload);

      // Send the notification immediately, without waiting for the API.
      const initialEmbed = buildRestockEmbed(payload, null);
      const message = await sendToChannel(
        RESTOCK_CHANNEL_ID,
        { embeds: [initialEmbed] }
      );

      console.log(
        "Restock notification sent:",
        new Date().toISOString(),
        "product:",
        productId || "unknown"
      );

      // Look up the product in the background and update the message.
      if (productId && SELLAUTH_API_KEY) {
        getSellAuthProduct(productId)
          .then(async (apiProduct) => {
            if (!apiProduct) {
              console.warn(
                "SellAuth product not found in API response:",
                productId
              );
              return;
            }

            const updatedEmbed = buildRestockEmbed(payload, apiProduct);

            await message.edit({ embeds: [updatedEmbed] });

            console.log(
              "Restock notification updated with product data:",
              productId
            );
          })
          .catch((error) => {
            console.error(
              "SellAuth product lookup failed:",
              error.message
            );
          });
      }

      return;
    }

    if (isSale) {
      await sendToChannel(SALES_CHANNEL_ID, {
        embeds: [buildSaleEmbed(payload)],
      });

      console.log("Sale notification sent:", new Date().toISOString());
      return;
    }

    console.log("SellAuth event ignored:", event || "(unknown)");
  } catch (error) {
    console.error("SellAuth webhook processing error:", error);
  }
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (_req, res) => {
  res.status(200).send("SIMBA SHOP Discord bot is running.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    bot: client.isReady(),
    timestamp: new Date().toISOString(),
  });
});

// --------------------------------------------------
// START SERVER AND BOT
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

async function startBot() {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error("Bot startup error:", error);
    process.exitCode = 1;
  }
}

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in Railway variables.");
} else {
  startBot();
}
