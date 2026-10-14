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
} = require("discord.js");

const app = express();
const PORT = Number(process.env.PORT || 10000);

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
  .addChannelOption((option) =>
    option
      .setName("canal")
      .setDescription("Channel where the message will be sent")
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
      )
      .setRequired(true)
  )
  .addStringOption((option) =>
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
  const {
    DISCORD_TOKEN,
    CLIENT_ID,
    GUILD_ID,
  } = process.env;

  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("Missing Discord environment variables.");
    return;
  }

  try {
    const rest = new REST({ version: "10" })
      .setToken(DISCORD_TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      {
        body: [
          sayCommand,
          testVentaCommand,
          testStockCommand,
        ].map((command) => command.toJSON()),
      }
    );

    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Command registration failed:", error);
  }
}

// =====================================
// HELPERS
// =====================================

function firstDefined(...values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ""
  );
}

function getOrder(payload) {
  return (
    payload?.data?.order ||
    payload?.data ||
    payload?.order ||
    payload
  );
}

function getFirstItem(order) {
  return (
    order?.items?.[0] ||
    order?.line_items?.[0] ||
    order?.products?.[0] ||
    order?.product ||
    {}
  );
}

function getEventName(payload, req) {
  return String(
    firstDefined(
      req.headers["x-sellauth-event"],
      req.headers["x-webhook-event"],
      payload?.event,
      payload?.type,
      payload?.name,
      ""
    )
  ).toLowerCase();
}

function getDeliveryId(payload, req) {
  return String(
    firstDefined(
      req.headers["x-sellauth-delivery"],
      req.headers["x-webhook-id"],
      payload?.delivery_id,
      payload?.id,
      ""
    )
  );
}

function formatMoney(value, currency = "") {
  if (value === undefined || value === null || value === "") {
    return "—";
  }

return String(value) + (currency ? " " + currency : "");
}


return String(value) + (currency ? " " + String(currency) : "");
}

function safeText(value, fallback = "Unknown") {
  const text = String(firstDefined(value, fallback));
  return text.slice(0, 1000);
}

// =====================================
// EMBEDS
// =====================================

function buildSaleEmbed(payload) {
  const order = getOrder(payload);
  const item = getFirstItem(order);

  const product = firstDefined(
    item.product_title,
    item.title,
    item.name,
    order.product_title,
    order.product_name,
    "Product"
  );

  const orderId = firstDefined(
    order.uniqid,
    order.order_id,
    order.id,
    "Unknown"
  );

  const total = firstDefined(
    order.total,
    order.price,
    order.amount,
    item.total,
    item.unit_price,
    "—"
  );

  const currency = firstDefined(
    order.currency,
    order.currency_code,
    ""
  );

  const quantity = firstDefined(
    item.quantity,
    item.qty,
    order.quantity,
    1
  );

  const payment = firstDefined(
    order.gateway,
    order.payment_method,
    order.payment?.method,
    "Unknown"
  );

  const coupon = firstDefined(
    order.coupon_code,
    order.discount_code,
    order.coupon,
    "No"
  );

  const customer = firstDefined(
    order.customer_email,
    order.email,
    order.customer?.email,
    "Unknown"
  );

  const embed = new EmbedBuilder()
    .setColor("#D4AF37")
    .setTitle("🦁 SIMBA SHOP • New Order")
   .setDescription("🛒 **New Sale • " + safeText(product) + "**")
    .addFields(
      {
        name: "🔐 Product",
        value: safeText(product),
        inline: false,
      },
      {
        name: "📦 Quantity",
        value: safeText(quantity),
        inline: true,
      },
      {
        name: "💰 Total",
        value: formatMoney(total, currency),
        inline: true,
      },
      {
        name: "💳 Payment",
        value: safeText(payment),
        inline: true,
      },
      {
        name: "🎟️ Coupon",
        value: safeText(coupon),
        inline: true,
      },
      {
        name: "🆔 Order ID",
        value: safeText(orderId),
        inline: true,
      },
      {
        name: "📧 Customer",
        value: safeText(customer),
        inline: false,
      }
    )
    .setFooter({ text: "🦁 SIMBA SHOP • SellAuth" })
    .setTimestamp();

  const productUrl = firstDefined(
    item.product_url,
    item.url,
    order.product_url
  );

  if (
    typeof productUrl === "string" &&
    /^https:\/\/\S+$/i.test(productUrl)
  ) {
    embed.setURL(productUrl);
  }

  return embed;
}

function buildRestockEmbed(payload) {
  const data = payload?.data || payload;
  const product = data?.product || data;

  const title = firstDefined(
    product.product_title,
    product.title,
    product.name,
    data.product_title,
    "Product"
  );

  const variant = firstDefined(
    product.variant_title,
    product.variant?.name,
    data.variant_title,
    "Default"
  );

  const stock = firstDefined(
    product.available_stock,
    product.stock,
    product.quantity,
    product.stock_quantity,
    data.available_stock,
    data.stock,
    data.quantity,
    "Updated"
  );

  const price = firstDefined(
    product.price,
    data.price,
    "—"
  );

  const productUrl = firstDefined(
    product.url,
    product.product_url,
    data.product_url
  );

  const embed = new EmbedBuilder()
    .setColor("#D4AF37")
    .setTitle("📦 SIMBA SHOP • Restock")
    .setDescription(`🛍️ **${safeText(title)}**`)
    .addFields(
      {
        name: "📦 Variant",
        value: safeText(variant),
        inline: true,
      },
      {
        name: "💰 Price",
        value: safeText(price),
        inline: true,
      },
      {
        name: "📊 Stock",
        value: safeText(stock),
        inline: true,
      }
    )
    .setFooter({ text: "🦁 SIMBA SHOP • SellAuth" })
    .setTimestamp();

  if (
    typeof productUrl === "string" &&
    /^https:\/\/\S+$/i.test(productUrl)
  ) {
    embed.addFields({
      name: "🛒 Buy Now",
      value: `[Click here to purchase](${productUrl})`,
      inline: false,
    });

    embed.setURL(productUrl);
  }

  return embed;
}

// =====================================
// DISCORD CHANNEL HELPERS
// =====================================

async function sendToChannel(channelId, message) {
  if (!channelId) {
    throw new Error("Channel ID is not configured.");
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel?.isTextBased() || !channel.send) {
    throw new Error("Invalid Discord text channel.");
  }

  await channel.send(message);
}

async function sendSaleTest() {
  const fakeSale = {
    order: {
      id: "TEST-001",
      total: "5.00",
      currency: "USD",
      payment_method: "Test",
      customer_email: "test@example.com",
      items: [
        {
          product_title: "SIMBA SHOP Test",
          quantity: 1,
          unit_price: "5.00",
        },
      ],
    },
  };

  await sendToChannel(
    process.env.SALES_CHANNEL_ID,
    { embeds: [buildSaleEmbed(fakeSale)] }
  );
}

async function sendStockTest() {
  const fakeRestock = {
    product: {
      title: "SIMBA SHOP Test Restock",
      variant_title: "Default",
      stock: 24,
      price: "Test",
      product_url: "https://simbashop.myshoppex.io/",
    },
  };

  const embed = buildRestockEmbed(fakeRestock);

  embed.addFields({
    name: "➕ Added",
    value: "+1 (test)",
    inline: true,
  });

  await sendToChannel(
    process.env.RESTOCK_CHANNEL_ID,
    { embeds: [embed] }
  );
}

// =====================================
// WEBHOOK DEDUPLICATION
// =====================================

function wasProcessed(map, id) {
  if (!id) return false;

  if (map.has(id)) return true;

  map.set(id, Date.now());

  // Prevent unbounded memory growth.
  if (map.size > 2000) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }

  return false;
}

// =====================================
// SELLAUTH WEBHOOK
// =====================================

// Configure this URL in SellAuth:
// https://YOUR-RAILWAY-DOMAIN/webhooks/sellauth?token=YOUR_TOKEN

app.post(
  "/webhooks/sellauth",
  express.json({ limit: "1mb" }),
  async (req, res) => {
    const expectedToken = process.env.SELLAUTH_WEBHOOK_TOKEN;
    const receivedToken = String(req.query.token || "");

    if (!expectedToken || !receivedToken) {
      return res.status(401).json({
        ok: false,
        error: "Webhook authentication is not configured.",
      });
    }

    const expected = Buffer.from(expectedToken);
    const received = Buffer.from(receivedToken);

    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
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

    console.log("SellAuth webhook received:", event || "unknown");

    // Acknowledge duplicate deliveries.
    if (
      deliveryId &&
      wasProcessed(processedDeliveries, deliveryId)
    ) {
      return res.status(200).json({
        ok: true,
        duplicate: true,
      });
    }

    try {
      // Sales: only paid/completed orders.
      const isPaidOrder =
        event.includes("paid") ||
        event.includes("completed") ||
        event.includes("complete");

      const isOrderEvent =
        event.includes("order") ||
        event.includes("payment");

      if (isOrderEvent && isPaidOrder) {
        const order = getOrder(payload);

        const orderId = String(
          firstDefined(
            order.uniqid,
            order.order_id,
            order.id,
            deliveryId,
            ""
          )
        );

        if (!wasProcessed(processedOrders, orderId)) {
          await sendToChannel(
            process.env.SALES_CHANNEL_ID,
            { embeds: [buildSaleEmbed(payload)] }
          );

          console.log("Sale notification sent:", orderId);
        }
      }

      // Restock: event names must match those emitted by SellAuth.
      const isStockEvent =
        event.includes("stock") ||
        event.includes("restock") ||
        event.includes("product.available");

      if (isStockEvent) {
        await sendToChannel(
          process.env.RESTOCK_CHANNEL_ID,
          {
            content: "@everyone",
            allowedMentions: { parse: ["everyone"] },
            embeds: [buildRestockEmbed(payload)],
          }
        );

        console.log("Restock notification sent.");
      }

      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("SellAuth webhook error:", error);

      return res.status(500).json({
        ok: false,
        error: "Failed to process webhook.",
      });
    }
  }
);

// =====================================
// BASIC HEALTH CHECK
// =====================================

app.get("/", (_req, res) => {
  res.status(200).send("SIMBA SHOP bot is running.");
});

// =====================================
// DISCORD INTERACTIONS
// =====================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "say") {
      const allowedUserId = process.env.SAY_ALLOWED_USER_ID;

      if (!allowedUserId) {
        return interaction.reply({
          content: "SAY_ALLOWED_USER_ID is not configured.",
          ephemeral: true,
        });
      }

      if (interaction.user.id !== allowedUserId) {
        return interaction.reply({
          content: "You are not allowed to use this command.",
          ephemeral: true,
        });
      }

      const channel = interaction.options.getChannel("canal", true);
      const message = interaction.options.getString("mensaje", true);

      if (!channel.isTextBased() || !channel.send) {
        return interaction.reply({
          content: "Please choose a text channel.",
          ephemeral: true,
        });
      }

      await channel.send({
        content: message,
        allowedMentions: { parse: [] },
      });

      return interaction.reply({
        content: `Message sent to ${channel}.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "testventa") {
      await interaction.deferReply({ ephemeral: true });
      await sendSaleTest();

      return interaction.editReply(
        "✅ Sales test sent to the configured channel."
      );
    }

    if (interaction.commandName === "teststock") {
      await interaction.deferReply({ ephemeral: true });
      await sendStockTest();

      return interaction.editReply(
        "✅ Restock test sent to the configured channel."
      );
    }
  } catch (error) {
    console.error(
      `Command ${interaction.commandName} failed:`,
      error
    );

    const message = `❌ Error: ${error.message}`.slice(0, 1900);

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

// =====================================
// START SERVER AND BOT
// =====================================

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

client.once("ready", async () => {
  console.log(`Discord connected as ${client.user.tag}`);
  await registerCommands();
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is not set in Railway.");
} else {
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error("Discord login failed:", error.message);
  });
}
```
