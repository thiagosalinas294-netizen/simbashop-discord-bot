
require("dotenv").config();

const express = require("express");
const https = require("https");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  SAY_ALLOWED_USER_ID,
  SALES_CHANNEL_ID,
  RESTOCK_CHANNEL_ID,
  SHOPPEX_API_KEY,
  SHOPPEX_WEBHOOK_SECRET,
  STOCK_ROLE_ID,
} = process.env;

const STORE_URL = process.env.STORE_URL || "https://shoppex.io";
const SHOPPEX_API = "https://api.shoppex.io/dev/v1";
const GOLD = 0xd4af37;

const STOCK_ROLE = STOCK_ROLE_ID || "1550639490123694100";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Preserve the original request bytes for webhook signature verification.
app.use(express.json({
  limit: "1mb",
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function firstDefined(...values) {
  return values.find(
    value => value !== undefined && value !== null && value !== ""
  );
}

function money(value, currency = "EUR") {
  if (value === undefined || value === null || value === "") {
    return "Not available";
  }

  const number = Number(value);
  const formatted = Number.isFinite(number)
    ? number.toFixed(2)
    : String(value);

  const symbols = {
    EUR: "€",
    USD: "$",
    GBP: "£",
  };

  const code = String(currency || "EUR").toUpperCase();

  return symbols[code]
    ? `${symbols[code]}${formatted}`
    : `${formatted} ${code}`;
}

function maskEmail(email) {
  const value = String(email || "");
  const at = value.indexOf("@");

  if (at <= 0) return value;

  return value.slice(0, 2) + "·····" + value.slice(at);
}

function prettyText(value) {
  const text = String(value || "")
    .replace(/[_-]+/g, " ")
    .trim();

  return text
    ? text.charAt(0).toUpperCase() + text.slice(1)
    : "Not available";
}

function getProductId(payload) {
  const data = payload?.data || payload;

  return firstDefined(
    data?.product_id,
    data?.productId,
    data?.product?.uniqid,
    data?.product?.id,
    data?.uniqid,
    data?.id
  );
}

function getProductName(payload, product = null) {
  const data = payload?.data || payload;

  return firstDefined(
    data?.product_title,
    data?.product_name,
    data?.productName,
    data?.product?.title,
    data?.product?.name,
    product?.title,
    product?.name,
    "Digital product"
  );
}

function getProductImage(product) {
  const image = firstDefined(
    product?.image_url,
    product?.imageUrl,
    product?.image,
    product?.thumbnail,
    product?.cover,
    product?.images?.[0]?.url,
    product?.images?.[0]
  );

  if (typeof image === "string" &&
      /^https?:\/\/\S+$/i.test(image)) {
    return image;
  }

  if (image && typeof image === "object") {
    return firstDefined(
      image.url,
      image.src,
      image.href
    );
  }

  return null;
}

// --------------------------------------------------
// SHOPPEX API
// --------------------------------------------------

function shoppexRequest(path) {
  return new Promise((resolve, reject) => {
    if (!SHOPPEX_API_KEY) {
      return reject(
        new Error("SHOPPEX_API_KEY is missing")
      );
    }

    const request = https.request(
      {
        hostname: "api.shoppex.io",
        path: `/dev/v1${path}`,
        method: "GET",

        headers: {
          Authorization: `Bearer ${SHOPPEX_API_KEY}`,
          Accept: "application/json",
        },

        timeout: 15000,
      },

      response => {
        let body = "";

        response.setEncoding("utf8");

        response.on("data", chunk => {
          body += chunk;
        });

        response.on("end", () => {
          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            return reject(
              new Error(
                `Shoppex API HTTP ${response.statusCode}: ` +
                body.slice(0, 300)
              )
            );
          }

          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            reject(
              new Error("Invalid JSON from Shoppex API")
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("Shoppex API timeout")
      );
    });

    request.on("error", reject);

    request.end();
  });
}

async function getShoppexProduct(productId) {
  if (!productId) return null;

  const response = await shoppexRequest(
    `/products/${encodeURIComponent(productId)}?include_variants=true`
  );

  return response?.data?.product ||
    response?.data ||
    response?.product ||
    response ||
    null;
}

// --------------------------------------------------
// DISCORD CHANNELS
// --------------------------------------------------

async function sendToChannel(channelId, message) {
  if (!channelId) {
    throw new Error("Destination channel ID is missing");
  }

  const channel = await client.channels.fetch(channelId);

  if (
    !channel ||
    !channel.isTextBased() ||
    !channel.send
  ) {
    throw new Error("Invalid Discord text channel");
  }

  return channel.send(message);
}

// --------------------------------------------------
// SALE EMBED
// --------------------------------------------------

function buildSaleEmbed(payload) {
  const data = payload?.data || payload;

  const items = Array.isArray(data.line_items)
    ? data.line_items
    : [];

  const productNames = items.length
    ? items.map(item => {
        const name = item.product_title || "Digital product";
        const variant = item.variant_title;

        return variant
          ? `${name} - ${variant} ×${item.quantity || 1}`
          : `${name} ×${item.quantity || 1}`;
      })
    : [
        `${getProductName(payload)} ×${data.quantity || 1}`
      ];

  const total = firstDefined(
    data.total_display,
    data.total,
    data.amount,
    data.price,
    "Not available"
  );

  const currency = data.currency || "EUR";

  const method = firstDefined(
    data.gateway,
    data.crypto_gateway,
    data.apm_method,
    data.payment_method
  );

  const buyer = firstDefined(
    data.customer_email,
    data.email,
    data.customer?.email
  );

  const orderId = firstDefined(
    data.uniqid,
    data.order_id,
    data.invoice_id,
    data.id
  );

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setAuthor({
      name: "SIMBA SHOP · New Sale",
    })
    .setTitle("New order completed!")
    .setURL(STORE_URL)
    .setDescription(
      "**New sale completed!**\n" +
      "───────────────────────\n\n" +
      productNames.map(name => `🏷️ **${name}**`).join("\n")
    )
    .addFields(
      {
        name: "Amount",
        value: `\`${money(total, currency)}\``,
        inline: true,
      },
      {
        name: "Status",
        value: "`Completed`",
        inline: true,
      }
    );

  if (method) {
    embed.addFields({
      name: "Payment method",
      value: `\`${prettyText(method)}\``,
      inline: true,
    });
  }

  if (buyer) {
    embed.addFields({
      name: "Customer",
      value: `\`${maskEmail(buyer)}\``,
      inline: true,
    });
  }

  if (orderId) {
    embed.addFields({
      name: "Order",
      value: `\`#${String(orderId).slice(0, 100)}\``,
      inline: true,
    });
  }

  return embed
    .setTimestamp()
    .setFooter({
      text: "SIMBA SHOP · Shoppex",
    });
}

// --------------------------------------------------
// RESTOCK EMBED
// --------------------------------------------------

function buildRestockMessage(payload, product = null) {
  const data = payload?.data || payload;

  const productId = getProductId(payload);

  const productName = getProductName(
    payload,
    product
  );

  const variant = data?.variant ||
    product?.variants?.find(
      item => String(item.id) === String(data?.variant_id)
    );

  const variantName = firstDefined(
    data?.variant_title,
    data?.variant_name,
    variant?.title,
    variant?.name
  );

  const fullName = variantName
    ? `${productName} - ${variantName}`
    : productName;

  const price = firstDefined(
    data?.price,
    variant?.price,
    product?.price,
    "Not available"
  );

  const currency = firstDefined(
    data?.currency,
    variant?.currency,
    product?.currency,
    "EUR"
  );

  const stock = firstDefined(
    data?.stock,
    data?.stock_quantity,
    data?.quantity,
    variant?.stock,
    variant?.stock_quantity,
    product?.stock,
    product?.stock_quantity,
    product?.quantity
  );

  const image = getProductImage(product);

  const productUrl = firstDefined(
    data?.url,
    product?.url,
    product?.product_url,
    STORE_URL
  );

  const description =
    `**Service:** ${fullName}\n` +
    `**Available stock:** ${stock ?? "Not available"} units\n` +
    `**Price:** ${money(price, currency)}\n\n` +
    "**Information**\n" +
    "We have recently restocked this product!";

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${fullName} - RESTOCKED`.slice(0, 256))
    .setURL(productUrl)
    .setDescription(description)
    .setTimestamp()
    .setFooter({
      text: "SIMBA SHOP · Shoppex",
    });

  if (image) {
    embed.setImage(image);
  }

  const button = new ButtonBuilder()
    .setLabel("Buy Now")
    .setStyle(ButtonStyle.Link)
    .setURL(productUrl);

  const row = new ActionRowBuilder()
    .addComponents(button);

  return {
    content: `<@&${STOCK_ROLE}>`,
    embeds: [embed],
    components: [row],
    allowedMentions: {
      roles: [STOCK_ROLE],
    },
  };
}

// --------------------------------------------------
// WEBHOOK SIGNATURE VERIFICATION
// --------------------------------------------------

function verifyShoppexWebhook(req) {
  if (!SHOPPEX_WEBHOOK_SECRET) {
    console.error("SHOPPEX_WEBHOOK_SECRET is missing");
    return false;
  }

  const signatureHeader =
    req.headers["x-shoppex-signature-v2"];

  const deliveryId =
    req.headers["x-shoppex-delivery"];

  const timestampHeader =
    req.headers["x-shoppex-timestamp"];

  if (
    !signatureHeader ||
    !deliveryId ||
    !timestampHeader ||
    !req.rawBody
  ) {
    return false;
  }

  const parts = signatureHeader
    .split(",")
    .map(part => part.trim());

  if (!parts.includes("v1")) return false;

  const fields = {};

  for (const part of parts) {
    if (part.includes("=")) {
      const [key, value] = part.split("=", 2);
      fields[key] = value;
    }
  }

  const timestamp = fields.t;
  const signature = fields.h;

  if (
    !timestamp ||
    !signature ||
    timestamp !== String(timestampHeader) ||
    !/^[0-9a-f]{64}$/i.test(signature)
  ) {
    return false;
  }

  const age = Math.abs(
    Math.floor(Date.now() / 1000) - Number(timestamp)
  );

  if (age > 300) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", SHOPPEX_WEBHOOK_SECRET)
    .update(`${deliveryId}.${timestamp}.`, "utf8")
    .update(req.rawBody)
    .digest();

  const received = Buffer.from(signature, "hex");

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

// --------------------------------------------------
// WEBHOOK DEDUPLICATION
// --------------------------------------------------

const processedDeliveries = new Set();

function rememberDelivery(id) {
  processedDeliveries.add(id);

  // Keep memory bounded.
  if (processedDeliveries.size > 10000) {
    const oldest = processedDeliveries.values().next().value;
    processedDeliveries.delete(oldest);
  }
}

// --------------------------------------------------
// PROCESS SHOPPEX WEBHOOK
// --------------------------------------------------

async function processWebhook(event, payload) {
  try {
    console.log("Processing Shoppex event:", event);

    // PAID ORDER
    if (
      event === "order:paid" ||
      event === "order:paid:product"
    ) {
      await sendToChannel(SALES_CHANNEL_ID, {
        embeds: [
          buildSaleEmbed(payload),
        ],
      });

      console.log("Sale notification sent.");
      return;
    }

    // DIRECT STOCK CHANGE
    if (event === "product:stock") {
      const productId = getProductId(payload);

      let product = null;

      if (productId && SHOPPEX_API_KEY) {
        try {
          product = await getShoppexProduct(productId);
        } catch (error) {
          console.error(
            "Shoppex product lookup failed:",
            error.message
          );
        }
      }

      await sendToChannel(
        RESTOCK_CHANNEL_ID,
        buildRestockMessage(payload, product)
      );

      console.log(
        "Restock notification sent:",
        productId
      );

      return;
    }

    console.log("Ignored Shoppex event:", event);

  } catch (error) {
    console.error(
      "Webhook processing error:",
      error.message
    );

    throw error;
  }
}

// --------------------------------------------------
// SHOPPEX WEBHOOK ENDPOINT
// --------------------------------------------------

app.post("/webhooks/shoppex", async (req, res) => {
  // Verify signature before trusting or processing the payload.
  if (!verifyShoppexWebhook(req)) {
    console.warn("Invalid Shoppex webhook signature");

    return res.status(401).json({
      error: "Invalid webhook signature",
    });
  }

  const deliveryId =
    req.headers["x-shoppex-delivery"];

  if (processedDeliveries.has(deliveryId)) {
    return res.status(200).json({
      received: true,
      duplicate: true,
    });
  }

  const payload = req.body || {};

  const event = String(
    req.headers["x-shoppex-event"] ||
    payload.event ||
    ""
  );

  rememberDelivery(deliveryId);

  try {
    await processWebhook(event, payload);

    return res.status(200).json({
      received: true,
    });

  } catch (error) {
    // Allow Shoppex to retry failed deliveries.
    processedDeliveries.delete(deliveryId);

    return res.status(500).json({
      error: "Webhook processing failed",
    });
  }
});

// --------------------------------------------------
// SLASH COMMANDS
// --------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a message to a selected channel")
    .addChannelOption(option =>
      option
        .setName("canal")
        .setDescription("Channel where the message will be sent")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("mensaje")
        .setDescription("Message to send")
        .setRequired(true)
        .setMaxLength(2000)
    ),

  new SlashCommandBuilder()
    .setName("testventa")
    .setDescription("Test the sale notification"),

  new SlashCommandBuilder()
    .setName("teststock")
    .setDescription("Test the restock notification"),

  new SlashCommandBuilder()
    .setName("testshoppex")
    .setDescription("Test the Shoppex API connection"),

].map(command => command.toJSON());

// --------------------------------------------------
// REGISTER COMMANDS
// --------------------------------------------------

async function registerCommands() {
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    throw new Error(
      "Missing Discord configuration variables"
    );
  }

  const rest = new REST({
    version: "10",
  }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body: commands,
    }
  );

  console.log("Discord slash commands registered.");
}

// --------------------------------------------------
// DISCORD EVENTS
// --------------------------------------------------

client.once("clientReady", () => {
  console.log(
    `SIMBA SHOP online as ${client.user.tag}`
  );
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {

    // SAY
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

      const channel =
        interaction.options.getChannel("canal");

      const message =
        interaction.options.getString("mensaje", true);

      if (
        !channel ||
        !channel.isTextBased() ||
        !channel.send
      ) {
        return interaction.reply({
          content: "Please select a text channel.",
          ephemeral: true,
        });
      }

      await channel.send({
        content: message,
      });

      return interaction.reply({
        content: "Message sent successfully.",
        ephemeral: true,
      });
    }

    // TEST SALE
    if (interaction.commandName === "testventa") {
      await interaction.deferReply({
        ephemeral: true,
      });

      const payload = {
        event: "order:paid:product",

        data: {
          uniqid: "SIMBA-TEST-001",
          type: "PRODUCT",
          status: "COMPLETED",
          gateway: "LITECOIN",
          total: 1.50,
          currency: "EUR",
          customer_email: "test.user@proton.me",
          quantity: 1,
          product_title: "SIMBA SHOP Test Product",
          line_items: [
            {
              product_title: "SIMBA SHOP Test Product",
              quantity: 1,
            },
          ],
        },
      };

      await sendToChannel(SALES_CHANNEL_ID, {
        embeds: [
          buildSaleEmbed(payload),
        ],
      });

      return interaction.editReply(
        "Test sale notification sent successfully."
      );
    }

    // TEST RESTOCK
    if (interaction.commandName === "teststock") {
      await interaction.deferReply({
        ephemeral: true,
      });

      const payload = {
        event: "product:stock",

        data: {
          uniqid: "SIMBA-TEST-PRODUCT",
          product_title: "SIMBA SHOP Test Product",
          stock: 24,
          price: 1.00,
          currency: "EUR",
        },
      };

      const product = {
        uniqid: "SIMBA-TEST-PRODUCT",
        title: "SIMBA SHOP Test Product",
        price: 1.00,
        currency: "EUR",
        stock: 24,
      };

      await sendToChannel(
        RESTOCK_CHANNEL_ID,
        buildRestockMessage(payload, product)
      );

      return interaction.editReply(
        "Test restock notification sent successfully."
      );
    }

    // TEST SHOPPEX API
    if (interaction.commandName === "testshoppex") {
      await interaction.deferReply({
        ephemeral: true,
      });

      if (!SHOPPEX_API_KEY) {
        return interaction.editReply(
          "SHOPPEX_API_KEY is missing in Railway."
        );
      }

      const response = await shoppexRequest(
        "/me/capabilities"
      );

      console.log(
        "Shoppex API connection successful."
      );

      return interaction.editReply(
        "Shoppex API connection successful!"
      );
    }

  } catch (error) {
    console.error("Command error:", error);

    const message =
      "An error occurred. Check Railway logs.";

    if (
      interaction.deferred ||
      interaction.replied
    ) {
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
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (_req, res) => {
  res.status(200).send(
    "SIMBA SHOP Discord Bot - Shoppex is running."
  );
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    bot: client.isReady(),
    platform: "Shoppex",
    timestamp: new Date().toISOString(),
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// --------------------------------------------------
// START BOT
// --------------------------------------------------

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
  console.error("Missing DISCORD_TOKEN in Railway.");
} else {
  startBot();
}
