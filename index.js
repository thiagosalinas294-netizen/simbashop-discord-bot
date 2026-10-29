require("dotenv").config();

const express = require("express");
const https = require("https");
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
  SELLAUTH_API_KEY,
  SELLAUTH_WEBHOOK_TOKEN,
} = process.env;

const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID || "275335";
const STORE_URL = "https://simba-market.mysellauth.com/";
const GOLD = 0xd4af37;

// Rol que se menciona en cada restock (puedes cambiarlo con la variable STOCK_ROLE_ID)
const STOCK_ROLE_ID = process.env.STOCK_ROLE_ID || "1550639490123694100";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function firstDefined(...values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ""
  );
}

function formatMoney(value, currency = "EUR") {
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

  const number = Number(value);
  const formatted = Number.isFinite(number)
    ? number.toFixed(2)
    : String(value);

  return currency ? `${formatted} ${currency}` : formatted;
}

// Formato tipo "€0.79" para el restock
function formatPriceSymbol(value, currency = "EUR") {
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

  const number = Number(value);
  const formatted = Number.isFinite(number)
    ? number.toFixed(2)
    : String(value);

  const symbols = { EUR: "€", USD: "$", GBP: "£" };
  const code = String(currency || "").toUpperCase();

  return symbols[code]
    ? `${symbols[code]}${formatted}`
    : `${formatted} ${code}`.trim();
}

function getPath(object, path) {
  return path.split(".").reduce(
    (current, key) =>
      current && current[key] !== undefined
        ? current[key]
        : undefined,
    object
  );
}

function pickPath(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return undefined;
}

function isHttpUrl(value) {
  return (
    typeof value === "string" &&
    /^https?:\/\/\S+$/i.test(value)
  );
}

function normalizeUrl(candidate) {
  if (candidate && typeof candidate === "object") {
    candidate = firstDefined(
      candidate.url,
      candidate.src,
      candidate.href,
      candidate.original,
      candidate.original_url,
      candidate.originalUrl,
      candidate.permalink
    );
  }

  return isHttpUrl(candidate) ? candidate : null;
}

function getProductId(payload) {
  return firstDefined(
    payload?.data?.product_id,
    payload?.data?.productId,
    payload?.data?.product?.id,
    payload?.product_id,
    payload?.productId,
    payload?.product?.id
  );
}

function getVariantIds(payload) {
  const data = payload?.data || {};

  const ids = [
    ...(Array.isArray(data.restocked_variant_ids)
      ? data.restocked_variant_ids
      : []),
    data.variant_id,
    data.variantId,
    data.variant?.id,
    data.variant?.variant_id,
  ];

  return ids
    .filter((id) => id !== undefined && id !== null)
    .map(String);
}

function getProductName(payload, product) {
  return firstDefined(
    pickPath(payload, [
      "data.product.name",
      "data.product.title",
      "data.product_name",
      "data.productName",
      "data.name",
      "product.name",
      "product.title",
      "product_name",
      "productName",
    ]),
    product?.name,
    product?.title,
    product?.product_name,
    "Digital product"
  );
}

// --------------------------------------------------
// PRODUCT IMAGE AND BUY URL
// --------------------------------------------------

function getProductImage(payload, product, variant) {
  const paths = [
    "image_url",
    "imageUrl",
    "image",
    "thumbnail_url",
    "thumbnailUrl",
    "thumbnail",
    "cover_url",
    "coverUrl",
    "cover",
    "icon",
    "product_image",
    "productImage",
    "images.0.url",
    "images.0",
    "media.0.url",
    "media.0",
  ];

  const candidates = [
    pickPath(variant, paths),
    pickPath(product, paths),
    pickPath(payload, [
      "data.image_url",
      "data.imageUrl",
      "data.image",
      "data.product.image_url",
      "data.product.imageUrl",
      "data.product.image",
      "data.product.thumbnail",
      "data.product.cover",
    ]),
  ];

  for (const candidate of candidates) {
    const url = normalizeUrl(candidate);
    if (url) return url;
  }

  return null;
}

function getProductUrl(payload, product, variant) {
  const paths = [
    "url",
    "product_url",
    "productUrl",
    "permalink",
    "checkout_url",
    "checkoutUrl",
    "purchase_url",
    "purchaseUrl",
    "storefront_url",
    "storefrontUrl",
    "public_url",
    "publicUrl",
    "links.product",
    "links.storefront",
    "links.checkout",
  ];

  const candidates = [
    pickPath(variant, paths),
    pickPath(product, paths),
    pickPath(payload, [
      "data.product.url",
      "data.product.product_url",
      "data.product.productUrl",
      "data.product.permalink",
      "data.product.checkout_url",
      "data.product.storefront_url",
      "data.url",
      "data.product_url",
      "data.productUrl",
    ]),
  ];

  for (const candidate of candidates) {
    const url = normalizeUrl(candidate);
    if (url) return url;
  }

  return null;
}

function getVariants(product) {
  const variants = firstDefined(
    product?.variants,
    product?.product_variants,
    product?.productVariants
  );

  if (Array.isArray(variants)) return variants;

  if (variants && typeof variants === "object") {
    return Object.values(variants);
  }

  return [];
}

function findMatchingVariant(payload, product) {
  const variants = getVariants(product);

  if (!variants.length) return null;

  const ids = getVariantIds(payload);

  const matching = variants.find((variant) =>
    ids.includes(
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

  return matching || (variants.length === 1 ? variants[0] : null);
}

function findProductInResponse(response, productId) {
  if (!response) return null;

  if (Array.isArray(response)) {
    return (
      response.find(
        (item) =>
          String(
            firstDefined(
              item?.id,
              item?.product_id,
              item?.productId,
              ""
            )
          ) === String(productId)
      ) || null
    );
  }

  if (typeof response !== "object") return null;

  const responseId = firstDefined(
    response.id,
    response.product_id,
    response.productId
  );

  if (
    responseId !== undefined &&
    String(responseId) === String(productId)
  ) {
    return response;
  }

  for (const key of [
    "data",
    "product",
    "products",
    "results",
    "items",
  ]) {
    if (response[key] !== undefined) {
      const result = findProductInResponse(
        response[key],
        productId
      );

      if (result) return result;
    }
  }

  return null;
}

// --------------------------------------------------
// SELLAUTH API
// --------------------------------------------------

function sellAuthRequest(path) {
  return new Promise((resolve, reject) => {
    if (!SELLAUTH_API_KEY) {
      return reject(
        new Error("SELLAUTH_API_KEY is missing")
      );
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
                `SellAuth API HTTP ${response.statusCode}: ` +
                body.slice(0, 250)
              )
            );
          }

          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            reject(new Error("Invalid JSON from SellAuth"));
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("SellAuth API timed out")
      );
    });

    request.on("error", reject);
    request.end();
  });
}

async function getSellAuthProduct(productId) {
  if (!productId) return null;

  const base =
    `/v1/shops/${encodeURIComponent(SELLAUTH_SHOP_ID)}/products`;

  // Try the individual product endpoint first.
  try {
    const response = await sellAuthRequest(
      `${base}/${encodeURIComponent(productId)}`
    );

    const found = findProductInResponse(
      response,
      productId
    );

    if (found) return found;

    if (response && typeof response === "object") {
      const candidate =
        response.data?.product ||
        response.product ||
        response.data;

      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        const candidateId = firstDefined(
          candidate.id,
          candidate.product_id,
          candidate.productId
        );

        if (
          candidateId === undefined ||
          String(candidateId) === String(productId)
        ) {
          return candidate;
        }
      }
    }
  } catch (error) {
    console.warn(
      "Individual product lookup failed:",
      error.message
    );
  }

  // Fall back to the shop product list.
  const response = await sellAuthRequest(base);

  return findProductInResponse(response, productId);
}

// --------------------------------------------------
// SALE EMBED
// --------------------------------------------------

function buildSaleEmbed(payload) {
  const data = payload?.data || payload;

  const productName = firstDefined(
    data?.product?.name,
    data?.product?.title,
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
    data?.customer?.email,
    data?.email
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
    .setFooter({
      text: "🦁 SIMBA SHOP • SellAuth",
    });

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

// --------------------------------------------------
// RESTOCK MESSAGE (embed + botón Buy Now + mención @stock)
// --------------------------------------------------

function buildRestockMessage(payload, product = null) {
  const productId = getProductId(payload);
  const variant = findMatchingVariant(payload, product);
  const productName = getProductName(payload, product);

  const variantName = firstDefined(
    variant?.name,
    variant?.title,
    variant?.label,
    payload?.data?.variant_name,
    payload?.data?.variantName,
    typeof payload?.data?.variant === "string"
      ? payload.data.variant
      : undefined
  );

  const price = firstDefined(
    variant?.price,
    variant?.unit_price,
    variant?.unitPrice,
    variant?.price_amount,
    variant?.priceAmount,
    variant?.amount,
    product?.price,
    product?.unit_price,
    product?.unitPrice,
    payload?.data?.price,
    payload?.data?.amount,
    payload?.price,
    payload?.amount
  );

  const currency = firstDefined(
    variant?.currency,
    variant?.price_currency,
    product?.currency,
    product?.price_currency,
    payload?.data?.currency,
    payload?.currency,
    "EUR"
  );

  const stock = firstDefined(
    variant?.stock,
    variant?.quantity,
    variant?.stock_count,
    variant?.stockCount,
    product?.stock,
    product?.quantity,
    product?.stock_count,
    product?.stockCount,
    payload?.data?.stock,
    payload?.data?.quantity,
    payload?.stock,
    payload?.quantity
  );

  const imageUrl = getProductImage(
    payload,
    product,
    variant
  );

  const productUrl = getProductUrl(
    payload,
    product,
    variant
  );

  const buyUrl = productUrl || STORE_URL;

  // Nombre completo: "Producto - Variante"
  const fullName = variantName
    ? `${productName} - ${variantName}`
    : String(productName);

  const stockText =
    stock !== undefined ? `${stock} units` : "Not available";

  const description =
    `**Service:** ${fullName.slice(0, 200)}\n` +
    `**Available stock:** ${stockText}\n` +
    `**Price:** ${formatPriceSymbol(price, currency)}\n\n` +
    `**Information**\n` +
    `We have recently restocked this product!`;

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${fullName} - RESTOCKED`.slice(0, 256))
    .setURL(buyUrl)
    .setDescription(description);

  if (imageUrl) {
    embed.setImage(imageUrl);
    console.log(
      "Restock image URL found for product:",
      productId
    );
  } else {
    console.warn(
      "No product image URL found for product:",
      productId
    );
  }

  if (productUrl) {
    console.log(
      "Restock product URL found for product:",
      productId
    );
  } else {
    console.warn(
      "No product URL found in SellAuth data:",
      productId
    );
  }

  const button = new ButtonBuilder()
    .setLabel("Buy Now")
    .setStyle(ButtonStyle.Link)
    .setURL(buyUrl);

  const row = new ActionRowBuilder().addComponents(button);

  return {
    content: `<@&${STOCK_ROLE_ID}>`,
    embeds: [embed],
    components: [row],
    allowedMentions: { roles: [STOCK_ROLE_ID] },
  };
}

// --------------------------------------------------
// DISCORD CHANNEL
// --------------------------------------------------

async function sendToChannel(channelId, message) {
  if (!channelId) {
    throw new Error("Destination channel ID is missing");
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased() || !channel.send) {
    throw new Error("Destination is not a text channel");
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
    .setDescription("Test the sale notification"),

  new SlashCommandBuilder()
    .setName("teststock")
    .setDescription("Test the restock notification"),
].map((command) => command.toJSON());

async function registerCommands() {
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    throw new Error(
      "Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID"
    );
  }

  const rest = new REST({ version: "10" }).setToken(
    DISCORD_TOKEN
  );

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
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
      const message = interaction.options.getString(
        "mensaje",
        true
      );

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
          {
            name: "Product",
            value: "Test product",
            inline: true,
          },
          {
            name: "Amount",
            value: "1.00 EUR",
            inline: true,
          },
          {
            name: "Order ID",
            value: "TEST-001",
            inline: true,
          }
        )
        .setURL(STORE_URL)
        .setTimestamp()
        .setFooter({
          text: "🦁 SIMBA SHOP • SellAuth",
        });

      await sendToChannel(SALES_CHANNEL_ID, {
        embeds: [embed],
      });

      return interaction.editReply(
        "Test sale notification sent."
      );
    }

    if (interaction.commandName === "teststock") {
      await interaction.deferReply({ ephemeral: true });

      const payload = {
        event: "NOTIFICATION.SHOP_PRODUCT_RESTOCKED",
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

      let product = null;

      if (SELLAUTH_API_KEY) {
        try {
          product = await getSellAuthProduct(913357);
        } catch (error) {
          console.error(
            "Test product lookup failed:",
            error.message
          );
        }
      }

      await sendToChannel(
        RESTOCK_CHANNEL_ID,
        buildRestockMessage(payload, product)
      );

      return interaction.editReply(
        "Test restock notification sent."
      );
    }
  } catch (error) {
    console.error("Command error:", error);

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
// SELLAUTH WEBHOOK
// --------------------------------------------------

app.post("/webhooks/sellauth", (req, res) => {
  if (
    SELLAUTH_WEBHOOK_TOKEN &&
    req.query.token !== SELLAUTH_WEBHOOK_TOKEN
  ) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  const payload = req.body || {};

  const event = String(
    firstDefined(
      payload.event,
      payload.type,
      payload.name,
      ""
    )
  ).toLowerCase();

  console.log("SellAuth webhook received:", event);
  console.log(
    "SellAuth webhook keys:",
    Object.keys(payload)
  );

  // Respond immediately so SellAuth does not wait.
  res.status(200).json({ received: true });

  void processWebhook(event, payload);
});

async function processWebhook(event, payload) {
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
      let product = null;

      if (productId && SELLAUTH_API_KEY) {
        try {
          product = await getSellAuthProduct(productId);

          if (product) {
            console.log(
              "SellAuth product data retrieved:",
              productId
            );
          } else {
            console.warn(
              "Product not found in SellAuth API:",
              productId
            );
          }
        } catch (error) {
          console.error(
            "SellAuth product lookup failed:",
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
        new Date().toISOString(),
        "product:",
        productId
      );

      return;
    }

    if (isSale) {
      await sendToChannel(SALES_CHANNEL_ID, {
        embeds: [buildSaleEmbed(payload)],
      });

      console.log(
        "Sale notification sent:",
        new Date().toISOString()
      );

      return;
    }

    console.log(
      "SellAuth event ignored:",
      event || "(unknown)"
    );
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (_req, res) => {
  res.status(200).send(
    "SIMBA SHOP Discord bot is running."
  );
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    bot: client.isReady(),
    timestamp: new Date().toISOString(),
  });
});

// --------------------------------------------------
// START
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
  console.error(
    "Missing DISCORD_TOKEN in Railway variables."
  );
} else {
  startBot();
}
