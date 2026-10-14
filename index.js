
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

app.use(express.json({ limit: "1mb" }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const processedOrders = new Map();
const processedDeliveries = new Map();

// ================================
// SLASH COMMANDS
// ================================

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
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error(
      "Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID."
    );
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
      ].map((command) => command.toJSON()),
    }
  );

  console.log("Slash commands registered.");
}

// ================================
// HELPERS
// ================================

function firstDefined(...values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ""
  );
}

function safeText(value, fallback = "Not available") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "object") {
    if (value.name) return String(value.name);
    if (value.title) return String(value.title);
    if (value.email) return String(value.email);

    try {
      return JSON.stringify(value).slice(0, 1000);
    } catch {
      return fallback;
    }
  }

  return String(value).slice(0, 1000);
}

function formatMoney(value, currency = "") {
  if (value === undefined || value === null || value === "") {
    return "Not available";
  }

  return String(value) + (currency ? " " + String(currency) : "");
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
  const order = getOrder(payload);

  return (
    payload?.data?.product ||
    payload?.product ||
    payload?.data?.item ||
    payload?.item ||
    order?.items?.[0] ||
    order?.line_items?.[0] ||
    order?.products?.[0] ||
    order?.product ||
    payload?.data ||
    payload
  );
}

function getEventName(payload, req) {
  const headerEvent = firstDefined(
    req.headers["x-sellauth-event"],
    req.headers["x-webhook-event"]
  );

  const event = firstDefined(
    headerEvent,
    payload?.event,
    payload?.type,
    payload?.name,
    ""
  );

  return String(
    typeof event === "object"
      ? event.name || event.type || ""
      : event
  ).toLowerCase();
}

function getDeliveryId(payload, req) {
  return String(
    firstDefined(
      req.headers["x-sellauth-delivery"],
      req.headers["x-webhook-id"],
      payload?.delivery_id,
      payload?.event_id,
      ""
    )
  );
}

function remember(map, id) {
  if (!id) return;

  map.set(id, Date.now());

  if (map.size > 2000) {
    map.delete(map.keys().next().value);
  }
}

// ================================
// SALES EMBED
// ================================

function buildSaleEmbed(payload) {
  const order = getOrder(payload);
  const product = getProduct(payload);

  const productName = firstDefined(
    product?.name,
    product?.title,
    product?.product_name,
    order?.product_name,
    order?.name
  );

  const orderId = firstDefined(
    order?.id,
    order?.order_id,
    order?.uuid,
    payload?.order_id
  );

  const currency = firstDefined(
    order?.currency,
    order?.currency_code,
    payload?.currency,
    ""
  );

  const total = firstDefined(
    order?.total,
    order?.total_price,
    order?.price,
    order?.amount,
    payload?.total,
    payload?.amount
  );

  const quantity = firstDefined(
    product?.quantity,
    product?.qty,
    order?.quantity,
    1
  );

  const payment = firstDefined(
    order?.payment_method,
    order?.gateway,
    order?.payment?.method,
    payload?.payment_method
  );

  const customer = firstDefined(
    order?.customer?.email,
    order?.customer_email,
    order?.email,
    payload?.customer?.email
  );

  const coupon = firstDefined(
    order?.coupon_code,
    order?.coupon,
    payload?.coupon_code
  );

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("SIMBA SHOP | New Sale")
    .setDescription(
      "A new order has been received!"
    )
    .addFields(
      {
        name: "Product",
        value: safeText(productName),
        inline: false,
      },
      {
        name: "Quantity",
        value: safeText(quantity),
        inline: true,
      },
      {
        name: "Total",
        value: formatMoney(total, currency),
        inline: true,
      },
      {
        name: "Payment",
        value: safeText(payment),
        inline: true,
      },
      {
        name: "Coupon",
        value: safeText(coupon, "None"),
        inline: true,
      },
      {
        name: "Order ID",
        value: safeText(orderId),
        inline: true,
      },
      {
        name: "Customer",
        value: safeText(customer),
        inline: true,
      }
    )
    .setFooter({
      text: "SIMBA SHOP | SellAuth",
    })
    .setTimestamp();

  const productUrl = firstDefined(
    product?.url,
    product?.product_url,
    order?.product_url
  );

  if (
    typeof productUrl === "string" &&
    productUrl.startsWith("https://")
  ) {
    embed.setURL(productUrl);
  }

  return embed;
}

// ================================
// RESTOCK EMBED
// ================================

function buildRestockEmbed(payload) {
  const product = getProduct(payload);

  const productName = firstDefined(
    product?.name,
    product?.title,
    product?.product_name,
    payload?.product_name
  );

  const variant = firstDefined(
    product?.variant_name,
    product?.variant?.name,
    product?.variant,
    payload?.variant_name
  );

  const stock = firstDefined(
    product?.stock,
    product?.stock_quantity,
    product?.quantity_available,
    product?.inventory,
    payload?.stock,
    payload?.stock_quantity,
    payload?.quantity,
    payload?.new_stock
  );

  const price = firstDefined(
    product?.price,
    product?.price_amount,
    payload?.price
  );

  const currency = firstDefined(
    product?.currency,
    payload?.currency,
    ""
  );

  const productUrl = firstDefined(
    product?.url,
    product?.product_url,
    product?.link,
    payload?.product_url
  );

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("SIMBA SHOP | Stock Replenished")
    .setDescription(
      "**A product's stock has been updated!**"
    )
    .addFields(
      {
        name: "Product",
        value: safeText(productName),
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
      }
    )
    .setFooter({
      text: "SIMBA SHOP | SellAuth",
    })
    .setTimestamp();

  if (
    typeof productUrl === "string" &&
    productUrl.startsWith("https://")
  ) {
    embed.addFields({
      name: "Purchase",
      value: "[Click here to purchase](" + productUrl + ")",
      inline: false,
    });

    embed.setURL(productUrl);
  }

  return embed;
}

// ================================
// SEND DISCORD MESSAGE
// ================================

async function sendToChannel(channelId, options) {
  if (!channelId) {
    throw new Error("The destination channel ID is missing.");
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased() || !channel.send) {
    throw new Error(
      "The configured destination is not a valid text channel."
    );
  }

  // Always send Discord message options.
  // Embeds must be inside the embeds array.
  return channel.send(options);
}

// ================================
// TEST COMMANDS
// ================================

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

  await sendToChannel(
    process.env.SALES_CHANNEL_ID,
    {
      embeds: [buildSaleEmbed(payload)],
      allowedMentions: { parse: [] },
    }
  );
}

async function sendStockTest() {
  const payload = {
    product: {
      name: "SIMBA SHOP Test Restock",
      variant_name: "Default",
      stock: 24,
      price: "Test",
      product_url: "https://simbashop.myshoppex.io/",
    },
  };

  await sendToChannel(
    process.env.RESTOCK_CHANNEL_ID,
    {
      content: "@everyone",
      embeds: [buildRestockEmbed(payload)],
      allowedMentions: { parse: ["everyone"] },
    }
  );
}

// ================================
// SELLAUTH WEBHOOK
// ================================

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

  if (deliveryId && processedDeliveries.has(deliveryId)) {
    console.log("Duplicate delivery ignored:", deliveryId);

    return res.status(200).json({
      ok: true,
      duplicate: true,
    });
  }

  try {
    const isStockEvent =
      event.includes("stock") ||
      event.includes("restock") ||
      event.includes("inventory");

    const isSaleEvent =
      !isStockEvent &&
      (
        event.includes("sale") ||
        event.includes("order") ||
        event.includes("payment") ||
        event.includes("paid") ||
        event.includes("completed") ||
        event.includes("complete")
      );

    if (isStockEvent) {
      await sendToChannel(
        process.env.RESTOCK_CHANNEL_ID,
        {
          content: "@everyone",
          embeds: [buildRestockEmbed(payload)],
          allowedMentions: {
            parse: ["everyone"],
          },
        }
      );

      console.log("Restock embed sent successfully.");
    } else if (isSaleEvent) {
      const order = getOrder(payload);

      const orderId = firstDefined(
        order?.id,
        order?.order_id,
        order?.uuid,
        payload?.order_id
      );

      if (orderId && processedOrders.has(String(orderId))) {
        console.log("Duplicate order ignored:", orderId);

        if (deliveryId) remember(processedDeliveries, deliveryId);

        return res.status(200).json({
          ok: true,
          duplicate: true,
        });
      }

      await sendToChannel(
        process.env.SALES_CHANNEL_ID,
        {
          embeds: [buildSaleEmbed(payload)],
          allowedMentions: {
            parse: [],
          },
        }
      );

      if (orderId) {
        remember(processedOrders, String(orderId));
      }

      console.log("Sale embed sent successfully.");
    } else {
      console.log(
        "Unrecognized SellAuth event. Payload keys:",
        Object.keys(payload)
      );
    }

    if (deliveryId) {
      remember(processedDeliveries, deliveryId);
    }

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

// ================================
// HEALTH CHECK
// ================================

app.get("/", (req, res) => {
  res.status(200).send("SIMBA SHOP bot is running.");
});

// ================================
// DISCORD INTERACTIONS
// ================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "say") {
      const allowedUserId = process.env.SAY_ALLOWED_USER_ID;

      if (
        !allowedUserId ||
        interaction.user.id !== allowedUserId
      ) {
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

      return interaction.editReply(
        "Sales embed sent successfully."
      );
    }

    if (interaction.commandName === "teststock") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      await sendStockTest();

      return interaction.editReply(
        "Restock embed sent successfully."
      );
    }
  } catch (error) {
    console.error("Interaction error:", error);

    const message =
      "An error occurred. Check the Railway logs.";

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

// ================================
// START BOT
// ================================

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
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error("Discord login error:", error);
  });
}
