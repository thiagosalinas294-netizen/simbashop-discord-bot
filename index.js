require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} = require("discord.js");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ===============================
// HELPERS
// ===============================

function money(value, currency = "") {
  if (value === undefined || value === null || value === "") {
    return "—";
  }

  return `${value}${currency ? ` ${currency}` : ""}`;
}

function firstDefined(...values) {
  return values.find(
    (v) => v !== undefined && v !== null && v !== ""
  );
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
  return (
    order?.items?.[0] ||
    order?.line_items?.[0] ||
    {}
  );
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

// ===============================
// SALE EMBED
// ===============================

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

  const currency = firstDefined(
    order.currency,
    ""
  );

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
    .setDescription(
      `🛒 **New Sale • ${productTitle}**`
    )
    .addFields(
      {
        name: "🔐 Product",
        value: String(productTitle),
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
    .setFooter({
      text: "🦁 SIMBA SHOP • Shoppex",
    })
    .setTimestamp();

  if (productUrl) {
    embed.setURL(productUrl);
  }

  return embed;
}

// ===============================
// RESTOCK EMBED
// ===============================

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
      `🛍️ **${productTitle}**${
        variantTitle ? ` — ${variantTitle}` : ""
      }`
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

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  if (productUrl) {
    embed.setURL(productUrl);
  }

  return embed;
}

// ===============================
// EVENT NAME
// ===============================

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

// ===============================
// WEBHOOK DUPLICATE PROTECTION
// ===============================

const processedOrders = new Map();

function isDuplicateSale(orderNumber) {
  if (!orderNumber || orderNumber === "Unknown") {
    return false;
  }

  if (processedOrders.has(orderNumber)) {
    return true;
  }

  processedOrders.set(
    orderNumber,
    Date.now()
  );

  setTimeout(() => {
    processedOrders.delete(orderNumber);
  }, 120000);

  return false;
}

// ===============================
// SHOPPEX WEBHOOK
// ===============================

app.post(
  "/webhooks/shoppex",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(
            String(req.body || "")
          );

      let payload = {};

      try {
        payload = JSON.parse(
          raw.toString("utf8")
        );
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Invalid JSON",
        });
      }

      const eventName = getEventName(
        payload,
        req
      );

      console.log(
        "Shoppex webhook:",
        eventName ||
          "(event header not found)"
      );

      const event = String(
        eventName
      ).toLowerCase();

      // ===========================
      // SALE
      // ===========================

      if (
        event.includes("paid") ||
        event.includes("order.paid") ||
        event.includes("order:paid")
      ) {
        if (process.env.SALES_CHANNEL_ID) {
          const channel =
            await client.channels.fetch(
              process.env.SALES_CHANNEL_ID
            );

          if (channel?.isTextBased()) {
            const order =
              getOrder(payload);

            const orderNumber =
              firstDefined(
                order.uniqid,
                order.id,
                ""
              );

            if (
              !isDuplicateSale(
                orderNumber
              )
            ) {
              await channel.send({
                embeds: [
                  buildSaleEmbed(
                    payload
                  ),
                ],
              });

              console.log(
                `💰 Venta enviada: ${orderNumber}`
              );
            } else {
              console.log(
                `⚠️ Venta duplicada ignorada: ${orderNumber}`
              );
            }
          }
        }
      }

      // ===========================
      // STOCK / RESTOCK WEBHOOK
      // ===========================

      if (
        event.includes("stock") ||
        event.includes("restock") ||
        event.includes(
          "product.updated"
        )
      ) {
        if (
          process.env
            .RESTOCK_CHANNEL_ID
        ) {
          const channel =
            await client.channels.fetch(
              process.env
                .RESTOCK_CHANNEL_ID
            );

          if (channel?.isTextBased()) {
            await channel.send({
              content: "@everyone",
              allowedMentions: {
                parse: ["everyone"],
              },
              embeds: [
                buildRestockEmbed(
                  payload
                ),
              ],
            });
          }
        }
      }

      return res.status(200).json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "Webhook error:",
        error
      );

      return res.status(500).json({
        ok: false,
      });
    }
  }
);

// ===============================
// TEST VENTA
// ===============================

app.get(
  "/testventa",
  async (_req, res) => {
    try {
      if (
        !process.env
          .SALES_CHANNEL_ID
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "SALES_CHANNEL_ID no está configurado",
        });
      }

      const channel =
        await client.channels.fetch(
          process.env.SALES_CHANNEL_ID
        );

      if (!channel?.isTextBased()) {
        return res.status(500).json({
          ok: false,
          error:
            "El canal de ventas no es válido",
        });
      }

      const fakeSale = {
        order: {
          id: "TEST-001",
          total: "5.00",
          currency: "USD",
          payment_method: "Test",
          customer_email:
            "cliente-prueba@simbashop.com",
          items: [
            {
              product_title:
                "Producto de prueba",
              variant_title:
                "Default",
              quantity: 1,
              unit_price: "5.00",
            },
          ],
        },
      };

      await channel.send({
        embeds: [
          buildSaleEmbed(
            fakeSale
          ),
        ],
      });

      return res.json({
        ok: true,
        message:
          "Venta de prueba enviada a Discord",
      });
    } catch (error) {
      console.error(
        "Test venta error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

// ===============================
// TEST STOCK
// ===============================

app.get(
  "/teststock",
  async (_req, res) => {
    try {
      if (
        !process.env
          .RESTOCK_CHANNEL_ID
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "RESTOCK_CHANNEL_ID no está configurado",
        });
      }

      const channel =
        await client.channels.fetch(
          process.env
            .RESTOCK_CHANNEL_ID
        );

      if (!channel?.isTextBased()) {
        return res.status(500).json({
          ok: false,
          error:
            "El canal de stock no es válido",
        });
      }

      const fakeRestock = {
        product: {
          title:
            "roblox accounts unchecked",
          variant_title:
            "Default",
          stock: 24,
          price: "0.01 EUR",
          product_url:
            "https://simbashop.myshoppex.io/product/roblox-accounts-unchecked",
          image_url: "",
        },
      };

      const embed =
        buildRestockEmbed(
          fakeRestock
        );

      embed.addFields({
        name: "➕ Added",
        value: "+1",
        inline: true,
      });

      await channel.send({
        content: "@everyone",
        allowedMentions: {
          parse: ["everyone"],
        },
        embeds: [embed],
      });

      return res.json({
        ok: true,
        message:
          "Aviso de stock enviado a Discord",
      });
    } catch (error) {
      console.error(
        "Test stock error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

// ===============================
// TEST SHOPPEX
// ===============================

app.get(
  "/testshoppex",
  async (_req, res) => {
    try {
      if (
        !process.env
          .SHOPPEX_API_KEY
      ) {
        return res.status(500).json({
          ok: false,
          error:
            "SHOPPEX_API_KEY no está configurada",
        });
      }

      const response =
        await fetch(
          "https://api.shoppex.io/dev/v1/products",
          {
            headers: {
              Authorization:
                `Bearer ${process.env.SHOPPEX_API_KEY}`,
            },
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        console.error(
          "Shoppex API error:",
          data
        );

        return res.status(
          response.status
        ).json({
          ok: false,
          error: data,
        });
      }

      const products =
        (data.data || []).map(
          (product) => ({
            id: product.id,
            title: product.title,
            stock: product.stock,
            available_stock:
              product.available_stock,
            variants:
              product.variants || [],
          })
        );

      console.log(
        "Shoppex products:",
        products
      );

      return res.json({
        ok: true,
        products,
      });
    } catch (error) {
      console.error(
        "Shoppex API test error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

// ===============================
// SHOPPEX STOCK MONITOR
// ===============================

const previousStock =
  new Map();

let stockMonitorInitialized =
  false;

// ===============================
// GET REAL PRODUCT STOCK
// ===============================

async function getProductStock(
  productId
) {
  try {
    const response =
      await fetch(
        `https://api.shoppex.io/dev/v1/products/${productId}/stock`,
        {
          headers: {
            Authorization:
              `Bearer ${process.env.SHOPPEX_API_KEY}`,
          },
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        `❌ Error stock producto ${productId}:`,
        data
      );

      return null;
    }

    const stockData =
      data?.data || data;

    const stock = Number(
      stockData?.available_stock ??
      stockData?.stock ??
      0
    );

    return stock;
  } catch (error) {
    console.error(
      `❌ Error consultando stock ${productId}:`,
      error.message
    );

    return null;
  }
}

// ===============================
// CHECK SHOPPEX STOCK
// ===============================

async function checkShoppexStock() {
  try {
    if (
      !process.env
        .SHOPPEX_API_KEY
    ) {
      console.log(
        "Stock monitor: SHOPPEX_API_KEY no está configurada."
      );
      return;
    }

    if (!client.isReady()) {
      return;
    }

    // ===========================
    // GET PRODUCTS
    // ===========================

    const response =
      await fetch(
        "https://api.shoppex.io/dev/v1/products",
        {
          headers: {
            Authorization:
              `Bearer ${process.env.SHOPPEX_API_KEY}`,
          },
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        "❌ Shoppex products error:",
        data
      );
      return;
    }

    const products =
      data?.data || [];

    console.log(
      `🔎 Stock check: ${products.length} productos`
    );

    // ===========================
    // GET REAL STOCK
    // ===========================

    const productsWithStock =
      [];

    for (const product of products) {
      const currentStock =
        await getProductStock(
          product.id
        );

      if (
        currentStock === null
      ) {
        continue;
      }

      productsWithStock.push({
        ...product,
        realStock:
          currentStock,
      });

      console.log(
        `📦 ${product.title}: stock real = ${currentStock}`
      );
    }

    // ===========================
    // INITIALIZE
    // ===========================

    if (
      !stockMonitorInitialized
    ) {
      for (
        const product
        of productsWithStock
      ) {
        previousStock.set(
          product.id,
          product.realStock
        );

        console.log(
          `📦 Stock inicial: ${product.title} = ${product.realStock}`
        );
      }

      stockMonitorInitialized =
        true;

      console.log(
        `✅ Stock monitor iniciado. ${productsWithStock.length} productos registrados.`
      );

      return;
    }

    // ===========================
    // CHECK CHANNEL
    // ===========================

    if (
      !process.env
        .RESTOCK_CHANNEL_ID
    ) {
      console.log(
        "Stock monitor: RESTOCK_CHANNEL_ID no está configurado."
      );
      return;
    }

    const channel =
      await client.channels.fetch(
        process.env
          .RESTOCK_CHANNEL_ID
      );

    if (!channel?.isTextBased()) {
      console.error(
        "❌ Stock monitor: canal de stock inválido."
      );
      return;
    }

    // ===========================
    // COMPARE STOCK
    // ===========================

    for (
      const product
      of productsWithStock
    ) {
      const currentStock =
        product.realStock;

      const oldStock =
        previousStock.get(
          product.id
        );

      // Producto nuevo
      if (
        oldStock === undefined
      ) {
        previousStock.set(
          product.id,
          currentStock
        );

        console.log(
          `🆕 Producto nuevo: ${product.title} (${currentStock})`
        );

        continue;
      }

      console.log(
        `📊 ${product.title}: ${oldStock} → ${currentStock}`
      );

      // =========================
      // RESTOCK DETECTED
      // =========================

      if (
        currentStock >
        oldStock
      ) {
        const addedStock =
          currentStock -
          oldStock;

        const slug =
          String(
            product.title ||
              "product"
          )
            .toLowerCase()
            .trim()
            .replace(
              /\s+/g,
              "-"
            )
            .replace(
              /[^a-z0-9-]/g,
              ""
            );

        const productUrl =
          `https://simbashop.myshoppex.io/product/${slug}`;

        const restockPayload =
          {
            product: {
              title:
                product.title,
              variant_title:
                "Default",
              stock:
                currentStock,
              price:
                product.price ??
                "—",
              product_url:
                product.url ||
                product.product_url ||
                productUrl,
              image_url:
                product.image_url ||
                "",
            },
          };

        const embed =
          buildRestockEmbed(
            restockPayload
          );

        embed.addFields({
          name: "➕ Added",
          value:
            `+${addedStock}`,
          inline: true,
        });

        // =======================
        // SEND DISCORD
        // =======================

        await channel.send({
          content:
            "@everyone",
          allowedMentions: {
            parse: ["everyone"],
          },
          embeds: [
            embed,
          ],
        });

        console.log(
          `🚨 RESTOCK DETECTADO: ${product.title} (+${addedStock})`
        );
      }

      // =========================
      // SAVE CURRENT STOCK
      // =========================

      previousStock.set(
        product.id,
        currentStock
      );
    }
  } catch (error) {
    console.error(
      "❌ Stock monitor error:",
      error.message
    );
  }
}

// ===============================
// STOCK CHECK EVERY 30 SECONDS
// ===============================

setInterval(
  checkShoppexStock,
  30000
);

setTimeout(
  checkShoppexStock,
  5000
);

// ===============================
// SERVER
// ===============================

app.listen(
  PORT,
  () => {
    console.log(
      `HTTP server listening on port ${PORT}`
    );
  }
);

// ===============================
// DISCORD READY
// ===============================

client.once(
  "ready",
  () => {
    console.log(
      `Discord connected as ${client.user.tag}`
    );
  }
);

// ===============================
// DISCORD LOGIN
// ===============================

if (
  !process.env
    .DISCORD_TOKEN
) {
  console.warn(
    "DISCORD_TOKEN is not set yet."
  );
} else {
  client
    .login(
      process.env.DISCORD_TOKEN
    )
    .catch(
      (err) => {
        console.error(
          "Discord login failed:",
          err.message
        );
      }
    );
}
