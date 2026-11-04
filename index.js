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
const GOLD = 0xd4af37;
const STOCK_ROLE = STOCK_ROLE_ID || "1550639490123694100";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// --------------------------------------------------
// WEBHOOK REQUEST DIAGNOSTICS
// Must run BEFORE express.json()
// --------------------------------------------------

app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/shoppex")) {
    console.log("--------------------------------");
    console.log("[SHOPPEX] Incoming request");
    console.log("[SHOPPEX] Method:", req.method);
    console.log("[SHOPPEX] Path:", req.path);
    console.log("[SHOPPEX] Event header:", req.headers["x-shoppex-event"] || "Missing");
    console.log("[SHOPPEX] Delivery ID:", req.headers["x-shoppex-delivery"] || "Missing");
    console.log("[SHOPPEX] Timestamp:", req.headers["x-shoppex-timestamp"] || "Missing");
    console.log("[SHOPPEX] Content-Type:", req.headers["content-type"] || "Missing");
  }

  next();
});

// --------------------------------------------------
// JSON PARSER
// --------------------------------------------------

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
  return values.find(value =>
    value !== undefined &&
    value !== null &&
    value !== ""
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

function getData(payload) {
  return payload?.data ||
    payload?.payload ||
    payload ||
    {};
}

function getProduct(payload) {
  const data = getData(payload);

  return data?.product ||
    data?.variant?.product ||
    payload?.product ||
    {};
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
    data.stock,
    data.stock_quantity,
    data.quantity,
    data.new_stock,
    data.new_quantity,
    data.available_stock,
    data.available,
    data.inventory,
    data.total_stock,
    data.keys_count,
    data.key_count,
    variant.stock,
    variant.stock_quantity,
    variant.quantity,
    product.stock,
    product.stock_quantity,
    product.quantity,
    product.inventory,
    product.keys_count,
    product.key_count,
    payload?.stock,
    payload?.stock_quantity
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

  if (typeof image === "string" &&
      /^https?:\/\/\S+$/i.test(image)) {
    return image;
  }

  if (image && typeof image === "object") {
    return firstDefined(image.url, image.src, image.href);
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

// --------------------------------------------------
// DISCORD CHANNELS
// --------------------------------------------------

async function sendToChannel(channelId, message) {
  if (!channelId) {
    throw new Error("Destination channel ID is missing");
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel ||
      !channel.isTextBased() ||
      !channel.send) {
    throw new Error("Invalid Discord text channel");
  }

  return channel.send(message);
}

// --------------------------------------------------
// SALE EMBED
// --------------------------------------------------

function buildSaleEmbed(payload) {
  const data = getData(payload);

  const items = Array.isArray(data.line_items)
    ? data.line_items
    : [];

  const productNames = items.length
    ? items.map(item => {
        const name = item.product_title ||
          item.product_name ||
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
// RESTOCK MESSAGE
// --------------------------------------------------

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

// --------------------------------------------------
// WEBHOOK SIGNATURE VERIFICATION
// --------------------------------------------------

function verifyShoppexWebhook(req) {
  if (!SHOPPEX_WEBHOOK_SECRET) {
    console.error("[SHOPPEX] WEBHOOK SECRET IS MISSING");
    return false;
  }

  const signatureHeader =
    req.headers["x-shoppex-signature-v2"];

  const deliveryId =
    req.headers["x-shoppex-delivery"];

  const timestampHeader =
    req.headers["x-shoppex-timestamp"];

  if (!signatureHeader ||
      !deliveryId ||
      !timestampHeader ||
      !req.rawBody) {
    console.error("[SHOPPEX] Missing signature headers or raw body");
    return false;
  }

  const parts = signatureHeader
    .split(",")
    .map(part => part.trim());

  if (!parts.includes("v1")) {
    console.error("[SHOPPEX] Unsupported signature version");
    return false;
  }

  const fields = {};

  for (const part of parts) {
    if (part.includes("=")) {
      const [key, value] = part.split("=", 2);
      fields[key] = value;
    }
  }

  const timestamp = fields.t;
  const signature = fields.h;

  if (!timestamp ||
      !signature ||
      timestamp !== String(timestampHeader) ||
      !/^[0-9a-f]{64}$/i.test(signature)) {
    console.error("[SHOPPEX] Invalid signature format");
    return false;
  }

  const age = Math.abs(
    Math.floor(Date.now() / 1000) - Number(timestamp)
  );

  if (!Number.isFinite(age) || age > 300) {
    console.error("[SHOPPEX] Webhook timestamp expired");
    return false;
  }

  const expected = crypto
    .createHmac("sha256", SHOPPEX_WEBHOOK_SECRET)
    .update(`${deliveryId}.${timestamp}.`, "utf8")
    .update(req.rawBody)
    .digest();

  const received = Buffer.from(signature, "hex");

  const valid =
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);

  if (!valid) {
    console.error("[SHOPPEX] HMAC verification failed");
  } else {
    console.log("[SHOPPEX] Signature verified successfully");
  }

  return valid;
}

// --------------------------------------------------
// NEW SHOPPEX TEST ENDPOINT
// --------------------------------------------------

app.post("/webhooks/shoppex-test", (req, res) => {
  console.log("[SHOPPEX TEST] Endpoint reached.");

  if (!verifyShoppexWebhook(req)) {
    console.warn("[SHOPPEX TEST] Invalid signature.");

    return res.status(401).json({
      error: "Invalid webhook signature",
    });
  }

  const event = String(
    req.headers["x-shoppex-event"] ||
    req.body?.event ||
    ""
  ).trim().toLowerCase();

  console.log("[SHOPPEX TEST] Signature verified.");
  console.log("[SHOPPEX TEST] Event:", event || "No event");
  console.log("[SHOPPEX TEST] Payload keys:", Object.keys(req.body || {}));

  return res.status(200).json({
    received: true,
    endpoint: "shoppex-test",
  });
});

// --------------------------------------------------
// WEBHOOK DEDUPLICATION
// --------------------------------------------------

const processedDeliveries = new Set();

function rememberDelivery(id) {
  processedDeliveries.add(id);

  if (processedDeliveries.size > 10000) {
    const oldest = processedDeliveries.values().next().value;
    processedDeliveries.delete(oldest);
  }
}

// --------------------------------------------------
// PROCESS SHOPPEX EVENTS
// --------------------------------------------------

async function processWebhook(event, payload) {
  console.log("[SHOPPEX] Event received:", event);
  console.log("[SHOPPEX] Payload keys:", Object.keys(payload || {}));

  const data = getData(payload);

  console.log(
    "[SHOPPEX] Data keys:",
    Object.keys(data || {})
  );

  // SALE
  if (
    event === "order:paid" ||
    event === "order:paid:product"
  ) {
    console.log("[SHOPPEX] Processing sale...");

    await sendToChannel(SALES_CHANNEL_ID, {
      embeds: [buildSaleEmbed(payload)],
    });

    console.log("[SHOPPEX] Sale notification sent.");
    return;
  }

  // STOCK / RESTOCK
  if (
    event.includes("stock") ||
    event.includes("restock")
  ) {
    console.log("[SHOPPEX] Processing stock event...");

    console.log("[SHOPPEX] Product:", getProductName(payload));
    console.log("[SHOPPEX] Stock:", getStock(payload));

    const message = buildRestockMessage(payload);

    await sendToChannel(RESTOCK_CHANNEL_ID, message);

    console.log("[SHOPPEX] Restock notification sent.");
    return;
  }

  console.log("[SHOPPEX] Event ignored:", event || "EMPTY EVENT");
}

// --------------------------------------------------
// ORIGINAL SHOPPEX WEBHOOK ENDPOINT
// --------------------------------------------------

app.post("/webhooks/shoppex", async (req, res) => {
  console.log("[SHOPPEX] POST endpoint reached.");

  if (!verifyShoppexWebhook(req)) {
    console.warn("[SHOPPEX] Invalid signature.");

    return res.status(401).json({
      error: "Invalid webhook signature",
    });
  }

  const deliveryId =
    req.headers["x-shoppex-delivery"];

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
    ""
  ).trim().toLowerCase();

  console.log("[SHOPPEX] Verified event:", event);

  try {
    await processWebhook(event, payload);

    rememberDelivery(deliveryId);

    return res.status(200).json({
      received: true,
    });
  } catch (error) {
    console.error(
      "[SHOPPEX] Webhook processing error:",
      error
    );

    return res.status(500).json({
      error: "Webhook processing failed",
    });
  }
});

// --------------------------------------------------
// JSON PARSER ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  if (req.path.startsWith("/webhooks/shoppex")) {
    console.error("[SHOPPEX] JSON parsing error:", error.message);

    return res.status(400).json({
      error: "Invalid JSON body",
    });
  }

  console.error("[SERVER] Request error:", error.message);

  return res.status(400).json({
    error: "Bad request",
  });
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
    throw new Error("Missing Discord configuration variables");
  }

  const rest = new REST({
    version: "10",
  }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    {
      body: commands,
    }
  );

  console.log("Discord slash commands registered.");
}

// --------------------------------------------------
// STOCK POLLING (Shoppex API)
// Shoppex does not send a webhook when keys are uploaded,
// so the bot checks the stock by itself every few seconds.
// --------------------------------------------------

const POLL_SECONDS = Number(process.env.SHOPPEX_POLL_SECONDS || 60);
const stockCache = new Map();
let pollRunning = false;
let firstPollDone = false;

function shoppexGet(path) {
  return new Promise((resolve, reject) => {
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
        response.on("data", chunk => body += chunk);

        response.on("end", () => {
          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            return reject(new Error(
              `Shoppex API HTTP ${response.statusCode} on ${path.split("?")[0]}`
            ));
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Shoppex API returned invalid JSON"));
          }
        });
      }
    );

    request.on("timeout", () =>
      request.destroy(new Error("Shoppex API timeout"))
    );

    request.on("error", reject);
    request.end();
  });
}

async function fetchAllProducts() {
  const products = [];
  let cursor = null;

  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);

    const result = await shoppexGet(`/dev/v1/products?${query}`);
    const list = Array.isArray(result?.data) ? result.data : [];

    products.push(...list);

    if (
      !result?.pagination?.has_more ||
      !result?.pagination?.next_cursor
    ) {
      break;
    }

    cursor = result.pagination.next_cursor;
  }

  return products;
}

async function checkStock() {
  if (pollRunning) return;
  pollRunning = true;

  try {
    const products = await fetchAllProducts();

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
          "[STOCK] Could not read stock:",
          productId,
          error.message
        );
        continue;
      }

      const variants = Array.isArray(info?.variants)
        ? info.variants
        : [];

      const entries = variants.length
        ? variants.map(v => ({
            key: `${productId}:${v.id || v.uniqid}`,
            stock: v.available_stock ?? v.stock,
            unlimited: v.unlimited,
            variantTitle: v.title,
          }))
        : [{
            key: productId,
            stock: info?.available_stock ?? info?.stock,
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
            `[STOCK] ${name} ${entry.variantTitle || ""}: ${previous} -> ${current}`
          );

          await sendToChannel(
            RESTOCK_CHANNEL_ID,
            buildRestockMessage({
              event: "product:stock",
              data: {
                product_title: name,
                variant_title: entry.variantTitle,
                stock: current,
                price: product.price,
                currency: product.currency,
                product,
              },
            })
          );

          console.log("[STOCK] Restock notification sent.");
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
    console.error("[STOCK] Polling error:", error.message);
  } finally {
    pollRunning = false;
  }
}

function startStockPolling() {
  if (!SHOPPEX_API_KEY) {
    console.error("[STOCK] SHOPPEX_API_KEY is missing, polling disabled.");
    return;
  }

  console.log(`[STOCK] Polling every ${POLL_SECONDS} seconds.`);

  checkStock();
  setInterval(checkStock, POLL_SECONDS * 1000);
}

// --------------------------------------------------
// DISCORD EVENTS
// --------------------------------------------------

client.once("clientReady", () => {
  console.log(`SIMBA SHOP online as ${client.user.tag}`);
  startStockPolling();
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

      if (!channel ||
          !channel.isTextBased() ||
          !channel.send) {
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
        event: "product:stock",
        data: {
          uniqid: "SIMBA-TEST-PRODUCT",
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

      await shoppexGet("/dev/v1/me");

      console.log("[SHOPPEX] API connection successful.");

      return interaction.editReply(
        "Shoppex API connection successful!"
      );
    }

  } catch (error) {
    console.error("[DISCORD] Command error:", error);

    const message = "An error occurred. Check Railway logs.";

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
