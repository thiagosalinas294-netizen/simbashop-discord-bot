```js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  ChannelType,
  REST,
  Routes,
  MessageFlags,
} = require("discord.js");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const GOLD = 0xD4AF37;
const STORE_URL = "https://simba-market.mysellauth.com/";

app.use(express.json({ limit: "1mb" }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const processedOrders = new Map();
const processedDeliveries = new Map();

// =====================================
// SLASH COMMANDS
// =====================================

const sayCommand = new SlashCommandBuilder()
  .setName("say")
  .setDescription("Send a message through SIMBA SHOP")
  .addChannelOption(option =>
    option
      .setName("canal")
      .setDescription("Channel where the message will be sent")
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
      )
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName("mensaje")
      .setDescription("Message to send")
      .setMaxLength(2000)
      .setRequired(true)
  );

const testVentaCommand = new SlashCommandBuilder()
  .setName("testventa")
  .setDescription("Test the sales notification");

const testStockCommand = new SlashCommandBuilder()
  .setName("teststock")
  .setDescription("Test the restock notification");

async function registerCommands() {
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("Missing Discord command environment variables.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    {
      body: [
        sayCommand,
        testVentaCommand,
        testStockCommand,
      ].map(command => command.toJSON()),
    }
  );

  console.log("Slash commands registered.");
}

// =====================================
// DATA HELPERS
// =====================================

function firstDefined(...values) {
  return values.find(
    value => value !== undefined &&
      value !== null &&
      value !== ""
  );
}

function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getPath(object, path) {
  return path.split(".").reduce((current, key) => {
    if (current == null) return undefined;
    return current[key];
  }, object);
}

function collectObjects(root) {
  const result = [];
  const seen = new Set();

  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" ||
        depth > 12 || seen.has(value)) {
      return;
    }

    seen.add(value);
    result.push(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else {
      for (const item of Object.values(value)) {
        if (item && typeof item === "object") {
          walk(item, depth + 1);
        }
      }
    }
  }

  walk(root);
  return result;
}

function findDeepValue(root, aliases) {
  const objects = collectObjects(root);
  const wanted = aliases.map(normalizeKey);

  // Prefer exact field-name matches.
  for (const alias of wanted) {
    for (const object of objects) {
      if (Array.isArray(object)) continue;

      for (const [key, value] of Object.entries(object)) {
        if (
          normalizeKey(key) === alias &&
          value !== undefined &&
          value !== null &&
          value !== ""
        ) {
          return value;
        }
      }
    }
  }

  // Support common nested paths too.
  for (const alias of aliases) {
    const value = getPath(root, alias);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function safeText(value, fallback = "Not available") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "object") {
    const readable = firstDefined(
      value.name,
      value.title,
      value.label,
      value.email,
      value.id
    );

    if (readable !== undefined) return String(readable);

    return fallback;
  }

  return String(value).slice(0, 1000);
}

function formatMoney(value, currency = "") {
  if (value === undefined || value === null || value === "") {
    return "Not available";
  }

  let amount = value;
  let code = currency;

  if (typeof value === "object") {
    amount = firstDefined(value.amount, value.value, value.price);
    code = firstDefined(value.currency, value.currency_code, value.code, currency);

    if (amount === undefined) return "Not available";
  }

  if (typeof amount === "object") return "Not available";

  return String(amount) + (code ? " " + String(code) : "");
}

function getOrder(payload) {
  return (
    payload?.data?.order ||
    payload?.order ||
    payload?.data ||
    payload
  );
}

function getProduct(payload) {
  return (
    payload?.data?.product ||
    payload?.product ||
    payload?.data?.item ||
    payload?.item ||
    payload?.data?.variant?.product ||
    payload?.variant?.product ||
    payload?.order?.items?.[0] ||
    payload?.data?.order?.items?.[0] ||
    payload?.order?.line_items?.[0] ||
    payload?.data?.order?.line_items?.[0] ||
    payload?.order?.products?.[0] ||
    payload?.data?.order?.products?.[0] ||
    payload?.data ||
    payload
  );
}

function getEventName(payload, req) {
  const raw = firstDefined(
    req.headers["x-sellauth-event"],
    req.headers["x-webhook-event"],
    payload?.event,
    payload?.type,
    payload?.name,
    ""
  );

  if (typeof raw === "object") {
    return String(raw.name || raw.type || "").toLowerCase();
  }

  return String(raw).toLowerCase();
}

function getDeliveryId(payload, req) {
  return String(firstDefined(
    req.headers["x-sellauth-delivery"],
    req.headers["x-webhook-id"],
    payload?.delivery_id,
    payload?.event_id,
    ""
  ));
}

function remember(map, id) {
  if (!id) return;

  map.set(String(id), Date.now());

  if (map.size > 2000) {
    map.delete(map.keys().next().value);
  }
}

function findProductName(payload) {
  const product = getProduct(payload);

  return firstDefined(
    findDeepValue(product, [
      "product_name",
      "productName",
      "item_name",
      "itemName",
      "title",
      "name",
    ]),
    findDeepValue(payload?.data?.product, ["name", "title"]),
    findDeepValue(payload?.product, ["name", "title"]),
    findDeepValue(payload, [
      "product_name",
      "productName",
      "item_name",
      "itemName",
    ])
  );
}

function findProductUrl(payload) {
  const value = findDeepValue(getProduct(payload), [
    "product_url",
    "productUrl",
    "purchase_url",
    "purchaseUrl",
    "product_link",
    "productLink",
    "url",
    "link",
  ]);

  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return value;
  }

  return STORE_URL;
}

// =====================================
// SALES EMBED
// =====================================

function buildSaleEmbed(payload) {
  const order = getOrder(payload);
  const product = getProduct(payload);

  const name = findProductName(payload) ||
    findDeepValue(order, ["product_name", "productName"]) ||
    "Not available";

  const orderId = firstDefined(
    findDeepValue(order, ["order_id", "orderId", "id", "uuid"]),
    findDeepValue(payload, ["order_id", "orderId"])
  );

  const total = firstDefined(
    findDeepValue(order, [
      "total",
      "total_price",
      "totalPrice",
      "amount",
      "subtotal",
    ]),
    findDeepValue(payload, ["total", "total_price", "totalPrice"])
  );

  const currency = firstDefined(
    findDeepValue(order, ["currency", "currency_code", "currencyCode"]),
    findDeepValue(payload, ["currency", "currency_code"])
  );

  const quantity = firstDefined(
    findDeepValue(product, ["quantity", "qty", "amount_ordered"]),
    findDeepValue(order, ["quantity", "qty"]),
    1
  );

  const payment = findDeepValue(payload, [
    "payment_method",
    "paymentMethod",
    "gateway",
    "payment.method",
  ]);

  const customer = findDeepValue(payload, [
    "customer_email",
    "customerEmail",
    "buyer.email",
    "customer.email",
  ]);

  const coupon = findDeepValue(payload, [
    "coupon_code",
    "couponCode",
    "discount.code",
  ]);

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("🦁 SIMBA SHOP | New Sale")
    .setDescription("A new order has been received!")
    .addFields(
      { name: "Product", value: safeText(name), inline: false },
      { name: "Quantity", value: safeText(quantity, "1"), inline: true },
      { name: "Total", value: formatMoney(total, currency), inline: true },
      { name: "Payment", value: safeText(payment), inline: true },
      { name: "Coupon", value: safeText(coupon, "None"), inline: true },
      { name: "Order ID", value: safeText(orderId), inline: true },
      { name: "Customer", value: safeText(customer), inline: true }
    )
    .setFooter({ text: "🦁 SIMBA SHOP • Powered by SellAuth" })
    .setTimestamp();

  embed.setURL(findProductUrl(payload));

  const image = findDeepValue(product, [
    "image_url",
    "imageUrl",
    "thumbnail_url",
    "thumbnailUrl",
    "image",
    "thumbnail",
  ]);

  const imageUrl = typeof image === "string"
    ? image
    : image?.url;

  if (typeof imageUrl === "string" &&
      /^https?:\/\//i.test(imageUrl)) {
    embed.setThumbnail(imageUrl);
  }

  return embed;
}

// =====================================
// RESTOCK EMBED
// =====================================

function buildRestockEmbed(payload) {
  const product = getProduct(payload);

  const name = findProductName(payload);

  const variant = firstDefined(
    findDeepValue(product, [
      "variant_name",
      "variantName",
      "variant_title",
      "variantTitle",
    ]),
    findDeepValue(payload, [
      "variant_name",
      "variantName",
    ]),
    "Default"
  );

  const stock = findDeepValue(payload, [
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
  ]);

  const price = firstDefined(
    findDeepValue(product, [
      "unit_price",
      "unitPrice",
      "price_amount",
      "priceAmount",
      "price",
    ]),
    findDeepValue(payload, [
      "unit_price",
      "unitPrice",
      "price_amount",
      "priceAmount",
      "price",
    ])
  );

  const currency = firstDefined(
    findDeepValue(product, [
      "currency",
      "currency_code",
      "currencyCode",
    ]),
    findDeepValue(payload, [
      "currency",
      "currency_code",
      "currencyCode",
    ])
  );

  const url = findProductUrl(payload);

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
        value: "[Click here to purchase](" + url + ")",
        inline: false,
      }
    )
    .setURL(url)
    .setFooter({ text: "🦁 SIMBA SHOP • Powered by SellAuth" })
    .setTimestamp();

  const image = findDeepValue(product, [
    "image_url",
    "imageUrl",
    "thumbnail_url",
    "thumbnailUrl",
    "image",
    "thumbnail",
  ]);

  const imageUrl = typeof image === "string"
    ? image
    : image?.url;

  if (typeof imageUrl === "string" &&
      /^https?:\/\//i.test(imageUrl)) {
    embed.setThumbnail(imageUrl);
  }

  return embed;
}

// =====================================
// DISCORD SENDING
// =====================================

async function sendToChannel(channelId, options) {
  if (!channelId) {
    throw new Error("Destination channel ID is missing.");
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased() || !channel.send) {
    throw new Error("Destination is not a valid text channel.");
  }

  return channel.send(options);
}

// =====================================
// TEST COMMANDS
// =====================================

async function sendSaleTest() {
  const payload = {
    order: {
      id: "TEST-001",
      total: 5,
      currency: "USD",
      quantity: 1,
      payment_method: "Test payment",
      customer_email: "test@example.com",
      product: {
        name: "SIMBA SHOP Test Product",
        price: 5,
      },
    },
  };

  await sendToChannel(process.env.SALES_CHANNEL_ID, {
    embeds: [buildSaleEmbed(payload)],
    allowedMentions: { parse: [] },
  });
}

async function sendStockTest() {
  const payload = {
    product: {
      name: "SIMBA SHOP Test Restock",
      variant_name: "Default",
      stock: 24,
      price: 5,
      currency: "USD",
      product_url: STORE_URL,
    },
  };

  await sendToChannel(process.env.RESTOCK_CHANNEL_ID, {
    content: "@everyone",
    embeds: [buildRestockEmbed(payload)],
    allowedMentions: { parse: ["everyone"] },
  });
}

// =====================================
// SELLAUTH WEBHOOK
// =====================================

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

  // Log field names only, not customer data or secrets.
  console.log(
    "SellAuth payload top-level keys:",
    Object.keys(payload).join(", ")
  );

  if (deliveryId && processedDeliveries.has(deliveryId)) {
    return res.status(200).json({
      ok: true,
      duplicate: true,
    });
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
      console.log(
        "Restock fields detected:",
        JSON.stringify({
          product: findProductName(payload) || null,
          price: findDeepValue(payload, ["price", "unit_price", "price_amount"]) ?? null,
          stock: findDeepValue(payload, [
            "current_stock",
            "stock_quantity",
            "quantity_available",
            "new_stock",
            "stock",
            "inventory",
          ]) ?? null,
        })
      );

      await sendToChannel(process.env.RESTOCK_CHANNEL_ID, {
        content: "@everyone",
        embeds: [buildRestockEmbed(payload)],
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
      console.log(
        "Unrecognized SellAuth event:",
        event || "(no event name)"
      );
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

// =====================================
// HEALTH CHECK
// =====================================

app.get("/", (req, res) => {
  res.status(200).send("SIMBA SHOP bot is running.");
});

// =====================================
// INTERACTIONS
// =====================================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "say") {
      const allowedUserId = process.env.SAY_ALLOWED_USER_ID;

      if (!allowedUserId || interaction.user.id !== allowedUserId) {
        return interaction.reply({
          content: "You are not allowed to use this command.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.options.getChannel("canal");
      const message = interaction.options.getString("mensaje");

      if (!channel || !channel.isTextBased() || !channel.send) {
        return interaction.reply({
          content: "Please select a valid text channel.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await channel.send({
        content: message,
        allowedMentions: { parse: [] },
      });

      return interaction.reply({
        content: "Message sent to " + channel + ".",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === "testventa") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      await sendSaleTest();

      return interaction.editReply("Sales embed sent successfully.");
    }

    if (interaction.commandName === "teststock") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      await sendStockTest();

      return interaction.editReply("Restock embed sent successfully.");
    }
  } catch (error) {
    console.error("Interaction error:", error);

    const message = "An error occurred. Check the Railway logs.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
});

// =====================================
// START
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("HTTP server listening on port " + PORT);
});

client.once("ready", async () => {
  console.log("Discord connected as " + client.user.tag);

  try {
    await registerCommands();
  } catch (error) {
    console.error("Command registration error:", error);
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in Railway variables.");
} else {
  client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error("Discord login error:", error);
  });
}
```
