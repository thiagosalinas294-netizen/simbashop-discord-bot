
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

// ================================================
// CONFIGURATION
// ================================================

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

const STORE_URL =
  process.env.STORE_URL || "https://shoppex.io";

const GOLD = 0xd4af37;
const STOCK_ROLE =
  STOCK_ROLE_ID || "1550639490123694100";

const POLL_SECONDS = Math.max(
  30,
  Number(process.env.SHOPPEX_POLL_SECONDS || 60)
);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ================================================
// WEBHOOK DIAGNOSTICS
// ================================================

app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/shoppex")) {
    console.log("\n================================");
    console.log("[SHOPPEX] Incoming request");
    console.log("[SHOPPEX] Method:", req.method);
    console.log("[SHOPPEX] Path:", req.path);
    console.log(
      "[SHOPPEX] Event:",
      req.headers["x-shoppex-event"] || "Missing"
    );
    console.log(
      "[SHOPPEX] Delivery:",
      req.headers["x-shoppex-delivery"] || "Missing"
    );
    console.log(
      "[SHOPPEX] Timestamp:",
      req.headers["x-shoppex-timestamp"] || "Missing"
    );
    console.log("================================");
  }

  next();
});

// ================================================
// RAW BODY + JSON
// ================================================

app.use(express.json({
  limit: "2mb",
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

// ================================================
// HELPERS
// ================================================

function firstDefined(...values) {
  return values.find(value =>
    value !== undefined &&
    value !== null &&
    value !== ""
  );
}

function getData(payload) {
  return (
    payload?.data ||
    payload?.payload ||
    payload ||
    {}
  );
}

function getProduct(payload) {
  const data = getData(payload);

  return (
    data?.product ||
    data?.variant?.product ||
    payload?.product ||
    {}
  );
}

function getProductName(payload) {
  const data = getData(payload);
  const product = getProduct(payload);
  const variant = data?.variant || {};

  return firstDefined(
    data.product_title,
    data.product_name,
    data.productName,
    data.title,
    data.name,
    product.title,
    product.name,
    variant.product_title,
    payload?.product_title,
    "Digital product"
  );
}

function getStock(payload) {
  const data = getData(payload);
  const product = getProduct(payload);
  const variant = data?.variant || {};

  return firstDefined(
    data.available_stock,
    data.stock,
    data.stock_quantity,
    data.new_stock,
    data.new_quantity,
    data.quantity,
    data.inventory,
    data.total_stock,
    data.keys_count,
    data.key_count,
    variant.available_stock,
    variant.stock,
    variant.stock_quantity,
    variant.quantity,
    product.available_stock,
    product.stock,
    product.stock_quantity,
    product.quantity,
    product.inventory,
    product.keys_count,
    product.key_count,
    payload?.available_stock,
    payload?.stock
  );
}

function getImage(payload) {
  const data = getData(payload);
  const product = getProduct(payload);

  const image = firstDefined(
    data.image_url,
    data.image,
    product.image_url,
    product.image,
    product.thumbnail,
    product.cover,
    product.images?.[0]?.url,
    product.images?.[0]
  );

  if (
    typeof image === "string" &&
    /^https?:\/\/\S+$/i.test(image)
  ) {
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

function getProductUrl(payload) {
  const data = getData(payload);
  const product = getProduct(payload);

  const url = firstDefined(
    data.product_url,
    data.url,
    product.url,
    product.product_url,
    STORE_URL
  );

  return /^https?:\/\//i.test(String(url))
    ? String(url)
    : STORE_URL;
}

function money(value, currency = "EUR") {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
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
    ARS: "$",
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

// ================================================
// DISCORD CHANNELS
// ================================================

async function sendToChannel(channelId, message) {
  if (!channelId) {
    throw new Error("Channel ID is missing");
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

// ================================================
// SALE EMBED
// ================================================

function buildSaleEmbed(payload) {
  const data = getData(payload);

  const items = Array.isArray(data.line_items)
    ? data.line_items
    : [];

  const productNames = items.length
    ? items.map(item => {
        const name =
          item.product_title ||
          item.product_name ||
          item.title ||
          "Digital product";

        return `${name} ×${item.quantity || 1}`;
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
      productNames
        .map(name => `🏷️ **${name}**`)
        .join("\n")
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
    )
    .setTimestamp()
    .setFooter({
      text: "SIMBA SHOP · Shoppex",
    });

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

  return embed;
}

// ================================================
// RESTOCK EMBED
// ================================================

function buildRestockMessage(payload) {
  const data = getData(payload);
  const product = getProduct(payload);
  const variant = data.variant || {};

  const productName = getProductName(payload);

  const variantName = firstDefined(
    data.variant_title,
    data.variant_name,
    variant.title,
    variant.name
  );

  const fullName = variantName
    ? `${productName} - ${variantName}`
    : productName;

  const price = firstDefined(
    data.price,
    variant.price,
    product.price
  );

  const currency = firstDefined(
    data.currency,
    variant.currency,
    product.currency,
    "EUR"
  );

  const stock = getStock(payload);
  const image = getImage(payload);
  const productUrl = getProductUrl(payload);

  const description =
    `**Service:** ${fullName}\n` +
    `**Available stock:** ${stock ?? "Updated"} units\n` +
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

  if (image && /^https?:\/\//i.test(image)) {
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

// ================================================
// SHOPPEX WEBHOOK SIGNATURE
// ================================================

function verifyShoppexWebhook(req) {
  if (!SHOPPEX_WEBHOOK_SECRET) {
    console.error("[SHOPPEX] Missing webhook secret");
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
    console.error("[SHOPPEX] Missing signature data");
    return false;
  }

  const fields = {};

  for (const part of signatureHeader.split(",")) {
    const [key, ...rest] = part.trim().split("=");

    if (key && rest.length) {
      fields[key] = rest.join("=");
    }
  }

  const timestamp = fields.t;
  const signature = fields.h;

  if (
    !signature ||
    !timestamp ||
    !/^[0-9a-f]{64}$/i.test(signature) ||
    timestamp !== String(timestampHeader)
  ) {
    console.error("[SHOPPEX] Invalid signature format");
    return false;
  }

  const age = Math.abs(
    Math.floor(Date.now() / 1000) -
    Number(timestamp)
  );

  if (!Number.isFinite(age) || age > 300) {
    console.error("[SHOPPEX] Expired timestamp");
    return false;
  }

  // IMPORTANT:
  // Shoppex signs deliveryId.timestamp.rawBody
  // There is NO extra period after timestamp.

  const expected = crypto
    .createHmac("sha256", SHOPPEX_WEBHOOK_SECRET)
    .update(`${deliveryId}.${timestamp}.`, "utf8")
    .update(req.rawBody)
    .digest();

  // The signature base is deliveryId.timestamp + raw body.
  // Build the documented input without an extra separator.

  const correctExpected = crypto
    .createHmac("sha256", SHOPPEX_WEBHOOK_SECRET)
    .update(`${deliveryId}.${timestamp}`, "utf8")
    .update(req.rawBody)
    .digest();

  const received = Buffer.from(signature, "hex");

  const valid =
    received.length === correctExpected.length &&
    crypto.timingSafeEqual(received, correctExpected);

  if (valid) {
    console.log("[SHOPPEX] Signature verified.");
  } else {
    console.error("[SHOPPEX] HMAC verification failed.");
  }

  return valid;
}

// ================================================
// DELIVERY DEDUPLICATION
// ================================================

const processedDeliveries = new Set();

function rememberDelivery(id) {
  processedDeliveries.add(id);

  if (processedDeliveries.size > 10000) {
    const oldest = processedDeliveries.values().next().value;
    processedDeliveries.delete(oldest);
  }
}

// ================================================
// UPDATE STOCK CACHE FROM WEBHOOK
// ================================================

const stockCache = new Map();

function updateCacheFromWebhook(payload) {
  const data = getData(payload);
  const product = getProduct(payload);

  const productId = firstDefined(
    data.product_uniqid,
    data.product_id,
    product.uniqid,
    product.id
  );

  const variants = Array.isArray(data.variants)
    ? data.variants
    : Array.isArray(data.stock?.variants)
      ? data.stock.variants
      : [];

  if (productId && variants.length) {
    for (const variant of variants) {
      const id = variant.id || variant.uniqid || "default";
      const stock = Number(
        firstDefined(
          variant.available_stock,
          variant.stock
        )
      );

      if (Number.isFinite(stock)) {
        stockCache.set(`${productId}:${id}`, stock);
      }
    }
  }

  if (productId) {
    const stock = Number(getStock(payload));

    if (Number.isFinite(stock)) {
      stockCache.set(String(productId), stock);
    }
  }
}

// ================================================
// PROCESS SHOPPEX EVENTS
// ================================================

async function processWebhook(event, payload) {
  console.log("[SHOPPEX] Processing event:", event);

  const data = getData(payload);

  console.log(
    "[SHOPPEX] Payload keys:",
    Object.keys(payload || {})
  );

  console.log(
    "[SHOPPEX] Data keys:",
    Object.keys(data || {})
  );

  // PAID ORDERS
  if (
    event === "order:paid" ||
    event === "order:paid:product"
  ) {
    console.log("[SHOPPEX] Paid order detected.");

    await sendToChannel(SALES_CHANNEL_ID, {
      embeds: [buildSaleEmbed(payload)],
    });

    console.log("[SHOPPEX] Sale notification sent.");
    return;
  }

  // PRODUCT STOCK
  if (
    event === "product:stock" ||
    event.includes("restock") ||
    event.includes("stock")
  ) {
    console.log("[SHOPPEX] Stock update detected.");
    console.log(
      "[SHOPPEX] Product:",
      getProductName(payload)
    );
    console.log(
      "[SHOPPEX] Stock:",
      getStock(payload)
    );

    updateCacheFromWebhook(payload);

    await sendToChannel(
      RESTOCK_CHANNEL_ID,
      buildRestockMessage(payload)
    );

    console.log("[SHOPPEX] Restock notification sent.");
    return;
  }

  console.log("[SHOPPEX] Event ignored:", event);
}

// ================================================
// MAIN SHOPPEX WEBHOOK
// ================================================

app.post("/webhooks/shoppex", async (req, res) => {
  console.log("[SHOPPEX] Endpoint reached.");

  if (!verifyShoppexWebhook(req)) {
    return res.status(401).json({
      received: false,
      error: "Invalid webhook signature",
    });
  }

  const deliveryId =
    String(req.headers["x-shoppex-delivery"]);

  if (processedDeliveries.has(deliveryId)) {
    console.log("[SHOPPEX] Duplicate delivery:", deliveryId);

    return res.status(200).json({
      received: true,
      duplicate: true,
    });
  }

  const payload = req.body || {};

  const event = String(
    req.headers["x-shoppex-event"] ||
    payload.event ||
    payload.type ||
    payload.event_type ||
    ""
  ).trim().toLowerCase();

  console.log("[SHOPPEX] Verified event:", event);

  try {
    await processWebhook(event, payload);

    rememberDelivery(deliveryId);

    return res.status(200).json({
      received: true,
      event,
    });
  } catch (error) {
    console.error(
      "[SHOPPEX] Processing error:",
      error
    );

    return res.status(500).json({
      received: false,
      error: "Webhook processing failed",
    });
  }
});

// ================================================
// API REQUEST
// ================================================

function shoppexGet(path) {
  return new Promise((resolve, reject) => {
    if (!SHOPPEX_API_KEY) {
      return reject(new Error("SHOPPEX_API_KEY missing"));
    }

    const request = https.request(
      {
        hostname: "api.shoppex.io",
        path,
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
                `Shoppex API HTTP ${response.statusCode}: ${body.slice(0, 300)}`
              )
            );
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error("Shoppex API returned invalid JSON")
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Shoppex API timeout"));
    });

    request.on("error", reject);

    request.end();
  });
}

// ================================================
// FETCH ALL PRODUCTS
// ================================================

async function fetchAllProducts() {
  const products = [];
  let cursor = null;

  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({
      limit: "100",
    });

    if (cursor) {
      query.set("cursor", cursor);
    }

    const result = await shoppexGet(
      `/dev/v1/products?${query.toString()}`
    );

    const data = result?.data;

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.products)
        ? data.products
        : [];

    products.push(...list);

    const pagination = result?.pagination ||
      data?.pagination ||
      {};

    if (
      !pagination.has_more ||
      !pagination.next_cursor
    ) {
      break;
    }

    cursor = pagination.next_cursor;
  }

  return products;
}

// ================================================
// STOCK POLLING
// ================================================

let pollRunning = false;
let firstPollDone = false;

async function checkStock() {
  if (pollRunning || !SHOPPEX_API_KEY) return;

  pollRunning = true;

  try {
    const products = await fetchAllProducts();

    console.log(
      `[STOCK] Checking ${products.length} products.`
    );

    for (const product of products) {
      const productId = product.uniqid || product.id;

      if (!productId) continue;

      let info;

      try {
        const result = await shoppexGet(
          `/dev/v1/products/${encodeURIComponent(productId)}/stock`
        );

        info = result?.data || result;
      } catch (error) {
        console.error(
          "[STOCK] Could not read product:",
          productId,
          error.message
        );
        continue;
      }

      const variants = Array.isArray(info?.variants)
        ? info.variants
        : [];

      const entries = variants.length
        ? variants.map(variant => ({
            key: `${productId}:${variant.id || variant.uniqid}`,
            stock: firstDefined(
              variant.available_stock,
              variant.stock
            ),
            unlimited: variant.unlimited,
            variantTitle: variant.title,
          }))
        : [{
            key: String(productId),
            stock: firstDefined(
              info?.available_stock,
              info?.stock
            ),
            unlimited: info?.unlimited,
            variantTitle: null,
          }];

      for (const entry of entries) {
        if (entry.unlimited) continue;

        const current = Number(entry.stock);

        if (!Number.isFinite(current)) continue;

        const previous = stockCache.get(entry.key);

        stockCache.set(entry.key, current);

        if (
          firstPollDone &&
          previous !== undefined &&
          current > previous
        ) {
          const name =
            product.title ||
            product.name ||
            "Digital product";

          console.log(
            `[STOCK] ${name}: ${previous} -> ${current}`
          );

          const payload = {
            data: {
              product_title: name,
              variant_title: entry.variantTitle,
              stock: current,
              price: product.price,
              currency: product.currency,
              product,
            },
          };

          try {
            await sendToChannel(
              RESTOCK_CHANNEL_ID,
              buildRestockMessage(payload)
            );

            console.log(
              "[STOCK] Restock notification sent."
            );
          } catch (error) {
            console.error(
              "[STOCK] Discord delivery error:",
              error.message
            );
          }
        }
      }
    }

    if (!firstPollDone) {
      console.log(
        `[STOCK] Baseline saved for ${stockCache.size} items.`
      );
    }

    firstPollDone = true;

  } catch (error) {
    console.error(
      "[STOCK] Polling error:",
      error.message
    );
  } finally {
    pollRunning = false;
  }
}

function startStockPolling() {
  if (!SHOPPEX_API_KEY) {
    console.error(
      "[STOCK] API key missing. Polling disabled."
    );
    return;
  }

  console.log(
    `[STOCK] Polling every ${POLL_SECONDS} seconds.`
  );

  checkStock();

  setInterval(
    checkStock,
    POLL_SECONDS * 1000
  );
}

// ================================================
// SLASH COMMANDS
// ================================================

const commands = [
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Send a message to a channel")
    .addChannelOption(option =>
      option
        .setName("canal")
        .setDescription("Destination channel")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("mensaje")
        .setDescription("Message")
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

// ================================================
// REGISTER COMMANDS
// ================================================

async function registerCommands() {
  if (!CLIENT_ID || !GUILD_ID || !DISCORD_TOKEN) {
    throw new Error("Discord configuration missing");
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

  console.log("[DISCORD] Slash commands registered.");
}

// ================================================
// DISCORD INTERACTIONS
// ================================================

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
        data: {
          uniqid: "SIMBA-TEST-001",
          gateway: "LITECOIN",
          total: 1.50,
          currency: "EUR",
          customer_email: "test@example.com",
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
        embeds: [buildSaleEmbed(payload)],
      });

      return interaction.editReply(
        "Test sale notification sent successfully."
      );
    }

    // TEST STOCK
    if (interaction.commandName === "teststock") {
      await interaction.deferReply({
        ephemeral: true,
      });

      const payload = {
        data: {
          product_title: "SIMBA SHOP Test Product",
          stock: 24,
          price: 1.00,
          currency: "EUR",
        },
      };

      await sendToChannel(
        RESTOCK_CHANNEL_ID,
        buildRestockMessage(payload)
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

      const result = await shoppexGet("/dev/v1/me");

      console.log(
        "[SHOPPEX] API connection successful."
      );

      console.log(
        "[SHOPPEX] Account response keys:",
        Object.keys(result?.data || result || {})
      );

      return interaction.editReply(
        "Shoppex API connection successful!"
      );
    }

  } catch (error) {
    console.error(
      "[DISCORD] Command error:",
      error
    );

    const message =
      "An error occurred. Check Railway logs.";

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

// ================================================
// BOT READY
// ================================================

client.once("ready", () => {
  console.log(
    `[DISCORD] SIMBA SHOP online as ${client.user.tag}`
  );

  startStockPolling();
});

// ================================================
// HEALTH CHECK
// ================================================

app.get("/", (req, res) => {
  res.status(200).send(
    "SIMBA SHOP Discord Bot - Shoppex is running."
  );
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    bot: client.isReady(),
    platform: "Shoppex",
    timestamp: new Date().toISOString(),
  });
});

// ================================================
// SERVER START
// ================================================

app.listen(PORT, () => {
  console.log(
    `[SERVER] HTTP server listening on port ${PORT}`
  );
});

// ================================================
// START BOT
// ================================================

async function startBot() {
  try {
    if (!DISCORD_TOKEN) {
      throw new Error("DISCORD_TOKEN is missing");
    }

    await registerCommands();
    await client.login(DISCORD_TOKEN);

  } catch (error) {
    console.error(
      "[STARTUP] Bot startup error:",
      error
    );

    process.exit(1);
  }
}

startBot();
