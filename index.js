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

function money(value, currency = "") {
  if (value === undefined || value === null || value === "") return "—";
  return `${value}${currency ? ` ${currency}` : ""}`;
}

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

function getOrder(payload) {
  return payload?.data?.order || payload?.order || payload?.data || payload;
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

function buildSaleEmbed(payload) {
  const order = getOrder(payload);
  const item = getFirstItem(order);

  const productTitle = firstDefined(
    item.product_title,
    item.title,
    order.product_title,
    "Product"
  );

  const variantTitle = firstDefined(
    item.variant_title,
    item.variant,
    "Default"
  );

  const price = firstDefined(
    item.total,
    item.unit_price,
    order.total
  );

  const currency = firstDefined(order.currency, "");
  const method = firstDefined(
    order.gateway,
    order.payment_method,
    "Unknown"
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

  const imageUrl = firstDefined(
    item.image_url,
    item.image,
    order.image_url
  );

  const productUrl = getProductUrl(item, order);

  const embed = new EmbedBuilder()
    .setTitle("🔥 New sale completed!")
    .setDescription(`🏷️ **${productTitle}**${variantTitle ? ` — ${variantTitle}` : ""}`)
    .addFields(
      { name: "💰 Amount", value: money(price, currency), inline: true },
      { name: "💳 Method", value: String(method), inline: true },
      { name: "🕘 Status", value: "Completed", inline: true },
      { name: "🔑 Customer", value: String(customer), inline: false },
      { name: "🧾 Order", value: String(orderNumber), inline: true },
    )
    .setFooter({ text: "🦁 SIMBA SHOP • verified sale" })
    .setTimestamp();

  if (imageUrl) embed.setThumbnail(imageUrl);
  if (productUrl) embed.setURL(productUrl);

  return embed;
}

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
    data.image_url
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
    .setDescription(`🛍️ **${productTitle}**${variantTitle ? ` — ${variantTitle}` : ""}`)
    .addFields(
      { name: "📦 Variant", value: String(variantTitle), inline: true },
      { name: "💰 Price", value: String(price), inline: true },
      { name: "📊 Stock", value: String(stock), inline: true },
      {
        name: "🛒 Buy Now",
        value: productUrl ? `[Click here to purchase](${productUrl})` : "Product link unavailable",
        inline: false,
      },
    )
    .setFooter({ text: "🦁 SIMBA SHOP • Powered by Shoppex" })
    .setTimestamp();

  if (imageUrl) embed.setImage(imageUrl);
  if (productUrl) embed.setURL(productUrl);

  return embed;
}

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

// Temporary raw-body receiver.
// We will enable Shoppex signature verification after confirming the exact
// signature header/formula shown by Shoppex for this webhook.
app.post(
  "/webhooks/shoppex",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(String(req.body || ""));

      let payload = {};
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({ ok: false, error: "Invalid JSON" });
      }

      const eventName = getEventName(payload, req);
      console.log("Shoppex webhook:", eventName || "(event header not found)");

      // We intentionally accept multiple possible spellings while testing.
      const event = String(eventName).toLowerCase();

      if (
        event.includes("paid") ||
        event.includes("order.paid") ||
        event.includes("order:paid")
      ) {
        if (process.env.SALES_CHANNEL_ID) {
          const channel = await client.channels.fetch(process.env.SALES_CHANNEL_ID);
          if (channel?.isTextBased()) {
            await channel.send({ embeds: [buildSaleEmbed(payload)] });
          }
        }
      }

      if (
        event.includes("stock") ||
        event.includes("restock") ||
        event.includes("product.updated")
      ) {
        if (process.env.RESTOCK_CHANNEL_ID) {
          const channel = await client.channels.fetch(process.env.RESTOCK_CHANNEL_ID);
          if (channel?.isTextBased()) {
            await channel.send({
  content: "@everyone",
  embeds: [buildRestockEmbed(payload)]
});
          }
        }
      }

      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);
      return res.status(500).json({ ok: false });
    }
  }
);

app.get("/testventa", async (_req, res) => {
  try {
    if (!process.env.SALES_CHANNEL_ID) {
      return res.status(500).json({
        ok: false,
        error: "SALES_CHANNEL_ID no está configurado",
      });
    }

    const channel = await client.channels.fetch(
      process.env.SALES_CHANNEL_ID
    );

    if (!channel?.isTextBased()) {
      return res.status(500).json({
        ok: false,
        error: "El canal de ventas no es válido",
      });
    }

    const fakeSale = {
      order: {
        id: "TEST-001",
        total: "5.00",
        currency: "USD",
        payment_method: "Test",
        customer_email: "cliente-prueba@simbashop.com",
        items: [
          {
            product_title: "Producto de prueba",
            variant_title: "Default",
            unit_price: "5.00",
          },
        ],
      },
    };

    await channel.send({
      embeds: [buildSaleEmbed(fakeSale)],
    });

    return res.json({
      ok: true,
      message: "Venta de prueba enviada a Discord",
    });
  } catch (error) {
    console.error("Test venta error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/teststock", async (_req, res) => {
  try {
    if (!process.env.RESTOCK_CHANNEL_ID) {
      return res.status(500).json({
        ok: false,
        error: "RESTOCK_CHANNEL_ID no está configurado",
      });
    }

    const channel = await client.channels.fetch(
      process.env.RESTOCK_CHANNEL_ID
    );

    if (!channel?.isTextBased()) {
      return res.status(500).json({
        ok: false,
        error: "El canal de stock no es válido",
      });
    }

    const fakeRestock = {
      product: {
        title: "Producto de prueba",
        variant_title: "Default",
        stock: 10,
        price: "5.00 USD",
      },
    };

    await channel.send({
      embeds: [buildRestockEmbed(fakeRestock)],
    });

    return res.json({
      ok: true,
      message: "Aviso de stock enviado a Discord",
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
    if (!process.env.SHOPPEX_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "SHOPPEX_API_KEY no está configurada",
      });
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
      console.error("Shoppex API error:", data);

      return res.status(response.status).json({
        ok: false,
        error: data,
      });
    }

    const products = (data.data || []).map((product) => ({
      id: product.id,
      title: product.title,
      stock: product.stock,
      available_stock: product.available_stock,
      variants: product.variants || [],
    }));

    console.log("Shoppex products:", products);

    return res.json({
      ok: true,
      products,
    });
  } catch (error) {
    console.error("Shoppex API test error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
// ===============================
// SHOPPEX STOCK MONITOR
// ===============================

const previousStock = new Map();
let stockMonitorInitialized = false;

async function checkShoppexStock() {
  try {
    if (!process.env.SHOPPEX_API_KEY) {
      console.log("Stock monitor: SHOPPEX_API_KEY no está configurada.");
      return;
    }

    if (!client.isReady()) {
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
      console.error("Stock monitor Shoppex error:", data);
      return;
    }

    const products = data.data || [];

    // Primera revisión: solamente guardamos el stock actual.
    if (!stockMonitorInitialized) {
      for (const product of products) {
        previousStock.set(product.id, Number(product.stock || 0));
      }

      stockMonitorInitialized = true;

      console.log(
        `Stock monitor iniciado. ${products.length} productos registrados.`
      );

      return;
    }

    if (!process.env.RESTOCK_CHANNEL_ID) {
      console.log("Stock monitor: RESTOCK_CHANNEL_ID no está configurado.");
      return;
    }

    const channel = await client.channels.fetch(
      process.env.RESTOCK_CHANNEL_ID
    );

    if (!channel?.isTextBased()) {
      console.error("Stock monitor: canal de stock inválido.");
      return;
    }

    for (const product of products) {
      const currentStock = Number(product.stock || 0);
      const oldStock = previousStock.get(product.id);

      // Producto nuevo que apareció después de iniciar el monitor.
      if (oldStock === undefined) {
        previousStock.set(product.id, currentStock);
        continue;
      }

      // Detectamos aumento de stock.
      if (currentStock > oldStock) {
        const addedStock = currentStock - oldStock;

        const restockPayload = {
          product: {
            title: product.title,
            variant_title: "Default",
            stock: currentStock,
            price: `${product.price ?? "—"} ${product.currency ?? ""}`.trim(),
            product_url: `https://simbashop.myshoppex.io/product/${product.title
  .toLowerCase()
  .trim()
  .replace(/\s+/g, "-")
  .replace(/[^a-z0-9-]/g, "")}`,
            image_url: product.image_url || "",
          },
        };

        const embed = buildRestockEmbed(restockPayload);

        embed.addFields({
          name: "➕ Added",
          value: `+${addedStock}`,
          inline: true,
        });

        await channel.send({
          embeds: [embed],
        });

        console.log(
          `📦 Restock detectado: ${product.title} (+${addedStock})`
        );
      }

      // Actualizamos el stock guardado.
      previousStock.set(product.id, currentStock);
    }
  } catch (error) {
    console.error("Stock monitor error:", error.message);
  }
}

// Revisar cada 30 segundos.
setInterval(checkShoppexStock, 30000);

// Primera revisión después de arrancar.
setTimeout(checkShoppexStock, 5000);
app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

client.once("ready", () => {
  console.log(`Discord connected as ${client.user.tag}`);
});

if (!process.env.DISCORD_TOKEN) {
  console.warn("DISCORD_TOKEN is not set yet.");
} else {
  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("Discord login failed:", err.message);
  });
}
