
require("dotenv").config();

const express = require("express");
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

const previousStock = new Map();
let stockMonitorInitialized = false;
const processedOrders = new Map();

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

const testShoppexCommand = new SlashCommandBuilder()
  .setName("testshoppex")
  .setDescription("Test the Shoppex API connection");

async function registerCommands() {
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error(
      "Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID in Railway."
    );
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(
      DISCORD_TOKEN
    );

    const commands = [
      sayCommand,
      testVentaCommand,
      testStockCommand,
      testShoppexCommand,
    ].map((command) => command.toJSON());

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error("Failed to register commands:", error);
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

function money(value, currency = "") {
  if (value === undefined || value === null || value === "") {
    return "—";
  }

  return `${value}${currency ? ` ${currency}` : ""}`;
}

function getOrder(payload) {
  return (
    payload?.data?.order ||
    payload?.order ||
    payload?.data ||
    payload
  );
}

function getFirstItem(order) {
  return order?.items?.[0] || order?.line_items?.[0] || {};
}

function getProductUrl(item, order) {
  return firstDefined(
    item.product_url,
    item.url,
    order.product_url,
    order.checkout_url,
    ""
  );
}

// =====================================
// SALE EMBED
// =====================================

function buildSaleEmbed(payload) {
  const order = getOrder(payload);
  const item = getFirstItem(order);

  const productTitle = firstDefined(
    item.product_title,
    item.title,
    order.product_title,
    "Product"
  );

  const quantity = firstDefined(
    item.quantity,
    item.qty,
    order.quantity,
    1
  );

  const total = firstDefined(
    order.total,
    item.total,
    item.unit_price,
    "—"
  );

  const currency = firstDefined(order.currency, "");
  const payment = firstDefined(
    order.gateway,
    order.payment_method,
    "Unknown"
  );

  const coupon = firstDefined(
    order.coupon,
    order.coupon_code,
    order.discount_code,
    "No"
  );

  const customer = firstDefined(
    order.customer_email,
    order.email,
    "Unknown"
  );

  const orderNumber = firstDefined(
    order.uniqid,
    order.id,
    "Unknown"
  );

  const location = firstDefined(
    order.location,
    order.customer_location,
    order.country,
    "Unknown"
  );

  const productUrl = getProductUrl(item, order);

  const embed = new EmbedBuilder()
    .setColor("#D4AF37")
    .setTitle("🦁 SIMBA SHOP • New Order")
    .setDescription(`🛒 **New Sale • ${productTitle}**`)
    .addFields(
      {
        name: "🔐 Product",
        value: String(productTitle).slice(0, 1024),
        inline: false,
      },
      {
        name: "📦 Quantity",
        value: String(quantity),
        inline: true,
      },
      {
        name: "💰 Total",
        value: money(total, currency),
        inline: true,
      },
      {
        name: "💳 Payment",
        value: String(payment),
        inline: true,
      },
      {
        name: "🎟️ Coupon",
        value: String(coupon),
        inline: true,
      },
      {
        name: "🆔 Order ID",
        value: String(orderNumber),
        inline: true,
      },
      {
        name: "📧 Customer",
        value: String(customer),
        inline: false,
      },
      {
        name: "🌎 Location",
        value: String(location),
        inline: false,
      }
    )
    .setFooter({ text: "🦁 SIMBA SHOP • Shoppex" })
    .setTimestamp();

  if (productUrl) embed.setURL(productUrl);

  return embed;
}

// =====================================
// RESTOCK EMBED
// =====================================

function buildRestockEmbed(payload) {
  const data = payload?.data || payload;
  const product = data?.product || data;

  const productTitle = firstDefined(
    product.product_title,
    product.title,
    data.product_title,
    "Product"
  );

  const variantTitle = firstDefined(
    product.variant_title,
    data.variant_title,
    "Default"
  );

  const stock = firstDefined(
    product.stock,
    data.stock,
    product.available_stock,
    data.available_stock,
    product.quantity,
    data.quantity,
    "?"
  );

  const price = firstDefined(
    product.price,
    data.price,
    "—"
  );

  const imageUrl = firstDefined(
    product.image_url,
    product.image,
    data.image_url,
    ""
  );

  const productUrl = firstDefined(
    product.url,
    product.product_url,
    data.product_url,
    ""
  );

  const embed = new EmbedBuilder()
    .setColor("#D4AF37")
    .setTitle("📦 Restock!")
    .setDescription(
      `🛍️ **${productTitle} — ${variantTitle}**`
    )
    .addFields(
      {
        name: "📦 Variant",
        value: String(variantTitle),
        inline: true,
      },
      {
        name: "💰 Price",
        value: String(price),
        inline: true,
      },
      {
        name: "📊 Stock",
        value: String(stock),
        inline: true,
      },
      {
        name: "🛒 Buy Now",
        value: productUrl
          ? `[Click here to purchase](${productUrl})`
          : "Product link unavailable",
        inline: false,
      }
    )
    .setFooter({
      text: "🦁 SIMBA SHOP • Powered by Shoppex",
    })
    .setTimestamp();

  if (imageUrl) embed.setImage(imageUrl);
  if (productUrl) embed.setURL(productUrl);

  return embed;
}

// =====================================
// DUPLICATE SALE PROTECTION
// =====================================

function isDuplicateSale(orderNumber) {
  if (!orderNumber || orderNumber === "Unknown") {
    return false;
  }

  if (processedOrders.has(String(orderNumber))) {
    return true;
  }

  processedOrders.set(String(orderNumber), Date.now());

  setTimeout(() => {
    processedOrders.delete(String(orderNumber));
  }, 120000);

  return false;
}

// =====================================
// TEST HELPERS
// =====================================

async function sendSaleTest() {
  if (!process.env.SALES_CHANNEL_ID) {
    throw new Error("SALES_CHANNEL_ID is not configured.");
  }

  const channel = await client.channels.fetch(
    process.env.SALES_CHANNEL_ID
  );

  if (!channel?.isTextBased() || !channel.send) {
    throw new Error("Invalid sales channel.");
  }

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

  await channel.send({
    embeds: [buildSaleEmbed(fakeSale)],
  });
}

async function sendStockTest() {
  if (!process.env.RESTOCK_CHANNEL_ID) {
    throw new Error("RESTOCK_CHANNEL_ID is not configured.");
  }

  const channel = await client.channels.fetch(
    process.env.RESTOCK_CHANNEL_ID
  );

  if (!channel?.isTextBased() || !channel.send) {
    throw new Error("Invalid restock channel.");
  }

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
    value: "+1",
    inline: true,
  });

  await channel.send({ embeds: [embed] });
}

async function testShoppexConnection() {
  if (!process.env.SHOPPEX_API_KEY) {
    throw new Error("SHOPPEX_API_KEY is not configured.");
  }

  const response = await fetch(
    "https://api.shoppex.io/dev/v1/products",
    {
      headers: {
        Authorization: `Bearer ${process.env.SHOPPEX_API_KEY}`,
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shoppex API returned ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data?.data || [];
}

// =====================================
// SHOPPEX WEBHOOK
// =====================================

function getEventName(payload, req) {
  return firstDefined(
    req.headers["x-shoppex-event"],
    req.headers["x-webhook-event"],
    payload?.event,
    payload?.type,
    payload?.name,
    ""
  );
}

app.post(
  "/webhooks/shoppex",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(String(req.body || ""));

      let payload;

      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Invalid JSON",
        });
      }

      const eventName = getEventName(payload, req);
      const event = String(eventName).toLowerCase();

      console.log("Shoppex webhook:", event || "unknown event");

      if (
        event.includes("paid") ||
        event.includes("order.paid") ||
        event.includes("order:paid")
      ) {
        if (process.env.SALES_CHANNEL_ID) {
          const channel = await client.channels.fetch(
            process.env.SALES_CHANNEL_ID
          );

          if (channel?.isTextBased() && channel.send) {
            const order = getOrder(payload);
            const orderNumber = firstDefined(
              order.uniqid,
              order.id,
              ""
            );

            if (!isDuplicateSale(orderNumber)) {
              await channel.send({
                embeds: [buildSaleEmbed(payload)],
              });

              console.log("Sale notification sent:", orderNumber);
            }
          }
        }
      }

      if (
        event.includes("stock") ||
        event.includes("restock") ||
        event.includes("product.updated")
      ) {
        if (process.env.RESTOCK_CHANNEL_ID) {
          const channel = await client.channels.fetch(
            process.env.RESTOCK_CHANNEL_ID
          );

          if (channel?.isTextBased() && channel.send) {
            await channel.send({
              content: "@everyone",
              allowedMentions: { parse: ["everyone"] },
              embeds: [buildRestockEmbed(payload)],
            });
          }
        }
      }

      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);

      return res.status(500).json({
        ok: false,
        error: "Internal server error",
      });
    }
  }
);

// =====================================
// HTTP TEST ROUTES
// =====================================

app.get("/testventa", async (_req, res) => {
  try {
    await sendSaleTest();

    return res.json({
      ok: true,
      message: "Sales test sent.",
    });
  } catch (error) {
    console.error("Test sale error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/teststock", async (_req, res) => {
  try {
    await sendStockTest();

    return res.json({
      ok: true,
      message: "Restock test sent.",
    });
  } catch (error) {
    console.error("Test stock error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/testshoppex", async (_req, res) => {
  try {
    const products = await testShoppexConnection();

    return res.json({
      ok: true,
      products: products.map((product) => ({
        id: product.id,
        title: product.title,
        stock: product.stock,
        available_stock: product.available_stock,
      })),
    });
  } catch (error) {
    console.error("Shoppex API test error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =====================================
// SHOPPEX STOCK MONITOR
// =====================================

async function getProductStock(productId) {
  try {
    const response = await fetch(
      `https://api.shoppex.io/dev/v1/products/${productId}/stock`,
      {
        headers: {
          Authorization: `Bearer ${process.env.SHOPPEX_API_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        `Stock error for ${productId}:`,
        data
      );
      return null;
    }

    const stockData = data?.data || data;

    return Number(
      stockData?.available_stock ??
      stockData?.stock ??
      0
    );
  } catch (error) {
    console.error("Stock request error:", error.message);
    return null;
  }
}

async function checkShoppexStock() {
  try {
    if (!process.env.SHOPPEX_API_KEY || !client.isReady()) {
      return;
    }

    const response = await fetch(
      "https://api.shoppex.io/dev/v1/products",
      {
        headers: {
          Authorization: `Bearer ${process.env.SHOPPEX_API_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Shoppex products error:", data);
      return;
    }

    const products = data?.data || [];
    const productsWithStock = [];

    for (const product of products) {
      const currentStock = await getProductStock(product.id);

      if (currentStock === null) continue;

      productsWithStock.push({
        ...product,
        realStock: currentStock,
      });
    }

    if (!stockMonitorInitialized) {
      for (const product of productsWithStock) {
        previousStock.set(product.id, product.realStock);
      }

      stockMonitorInitialized = true;
      console.log(
        `Stock monitor initialized: ${productsWithStock.length} products.`
      );
      return;
    }

    if (!process.env.RESTOCK_CHANNEL_ID) return;

    const channel = await client.channels.fetch(
      process.env.RESTOCK_CHANNEL_ID
    );

    if (!channel?.isTextBased() || !channel.send) {
      console.error("Invalid restock channel.");
      return;
    }

    for (const product of productsWithStock) {
      const currentStock = product.realStock;
      const oldStock = previousStock.get(product.id);

      if (oldStock === undefined) {
        previousStock.set(product.id, currentStock);
        continue;
      }

      if (currentStock > oldStock) {
        const addedStock = currentStock - oldStock;

        const slug = String(product.title || "product")
          .toLowerCase()
          .trim()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");

        const productUrl =
          product.url ||
          product.product_url ||
          `https://simbashop.myshoppex.io/product/${slug}`;

        const embed = buildRestockEmbed({
          product: {
            title: product.title,
            variant_title: "Default",
            stock: currentStock,
            price: product.price ?? "—",
            product_url: productUrl,
            image_url: product.image_url || "",
          },
        });

        embed.addFields({
          name: "➕ Added",
          value: `+${addedStock}`,
          inline: true,
        });

        await channel.send({
          content: "@everyone",
          allowedMentions: { parse: ["everyone"] },
          embeds: [embed],
        });

        console.log(
          `Restock detected: ${product.title} (+${addedStock})`
        );
      }

      previousStock.set(product.id, currentStock);
    }
  } catch (error) {
    console.error("Stock monitor error:", error.message);
  }
}

// =====================================
// DISCORD INTERACTIONS
// =====================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "say") {
      const allowedUserId = process.env.SAY_ALLOWED_USER_ID;

      if (!allowedUserId) {
        await interaction.reply({
          content:
            "The owner must configure SAY_ALLOWED_USER_ID in Railway.",
          ephemeral: true,
        });
        return;
      }

      if (interaction.user.id !== allowedUserId) {
        await interaction.reply({
          content: "You are not allowed to use this command.",
          ephemeral: true,
        });
        return;
      }

      const targetChannel =
        interaction.options.getChannel("canal", true);

      const message =
        interaction.options.getString("mensaje", true);

      if (!targetChannel.isTextBased() || !targetChannel.send) {
        await interaction.reply({
          content: "Please choose a text channel.",
          ephemeral: true,
        });
        return;
      }

      await targetChannel.send({
        content: message,
        allowedMentions: { parse: [] },
      });

      await interaction.reply({
        content: `Message sent to ${targetChannel}.`,
        ephemeral: true,
      });

      return;
    }

    if (interaction.commandName === "testventa") {
      await interaction.deferReply({ ephemeral: true });
      await sendSaleTest();

      await interaction.editReply(
        "✅ Sales test sent to the configured channel."
      );
      return;
    }

    if (interaction.commandName === "teststock") {
      await interaction.deferReply({ ephemeral: true });
      await sendStockTest();

      await interaction.editReply(
        "✅ Restock test sent to the configured channel."
      );
      return;
    }

    if (interaction.commandName === "testshoppex") {
      await interaction.deferReply({ ephemeral: true });

      const products = await testShoppexConnection();

      await interaction.editReply(
        `✅ Shoppex connected. Products found: ${products.length}.`
      );
      return;
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
// SERVER AND LOGIN
// =====================================

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

client.once("ready", async () => {
  console.log(`Discord connected as ${client.user.tag}`);

  await registerCommands();

  setTimeout(checkShoppexStock, 5000);
  setInterval(checkShoppexStock, 30000);
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is not set in Railway.");
} else {
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error("Discord login failed:", error.message);
  });
}
