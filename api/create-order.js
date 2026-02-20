const createMollieClient = require("@mollie/api-client").default;

const PRODUCT_CATALOG = {
  coin: { name: "Münzzähler", net: 1660.0 },
  cash: { name: "Münz & Scheinzähler", net: 1890.0 },
};

const clampQuantity = (q) => {
  const n = Number(q);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 50);
};

const to2 = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const apiKey = process.env.MOLLIE_LIVE_KEY || process.env.MOLLIE_TEST_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Missing Mollie API key",
        hint: "Check Vercel Environment Variables",
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({
          error: "Invalid JSON body",
          rawBody: req.body,
        });
      }
    }

    console.log("DEBUG BODY:", body);

    const {
      firstName,
      lastName,
      email,
      streetAndNumber,
      postalCode,
      city,
      country = "DE",
      vatRate = 19,
      cart = [],
    } = body || {};

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: "Missing customer fields", received: body });
    }

    if (!streetAndNumber || !postalCode || !city) {
      return res.status(400).json({ error: "Missing address fields", received: body });
    }

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Cart missing or empty", received: body });
    }

    const normalizedCart = cart
      .map((item) => ({
        productOption: String(item.productOption || "").trim(),
        quantity: clampQuantity(item.quantity),
      }))
      .filter((item) => item.productOption && PRODUCT_CATALOG[item.productOption] && item.quantity > 0);

    if (normalizedCart.length === 0) {
      return res.status(400).json({
        error: "Cart invalid after normalization",
        normalizedCart,
        received: body,
      });
    }

    const rate = Number(vatRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 30) {
      return res.status(400).json({ error: "Invalid VAT rate", received: body });
    }

    // Mollie Orders: gültige Kategorien sind eingeschränkt
    const ORDER_LINE_CATEGORY = "gift";

    const lines = normalizedCart.map((item) => {
      const product = PRODUCT_CATALOG[item.productOption];
      const netTotal = product.net * item.quantity;
      const grossTotal = netTotal * (1 + rate / 100);
      const vatAmount = grossTotal - netTotal;

      return {
        name: product.name,
        quantity: item.quantity,
        unitPrice: { currency: "EUR", value: to2(product.net * (1 + rate / 100)) },
        totalAmount: { currency: "EUR", value: to2(grossTotal) },
        vatRate: to2(rate),
        vatAmount: { currency: "EUR", value: to2(vatAmount) },
        category: ORDER_LINE_CATEGORY,
        sku: item.productOption,
      };
    });

    const totalGross = lines.reduce((sum, line) => sum + Number(line.totalAmount.value), 0);

    const mollie = createMollieClient({ apiKey });

    // Base Order Payload
    const baseOrderPayload = {
      amount: { currency: "EUR", value: to2(totalGross) },
      orderNumber: `BP-${Date.now()}`,
      locale: "de_DE",

      billingAddress: {
        givenName: firstName,
        familyName: lastName,
        email,
        streetAndNumber,
        postalCode,
        city,
        country,
      },
      shippingAddress: {
        givenName: firstName,
        familyName: lastName,
        email,
        streetAndNumber,
        postalCode,
        city,
        country,
      },

      lines,

      redirectUrl: process.env.MOLLIE_REDIRECT_URL || "https://boxplanet.shop/checkout/success",
      webhookUrl: process.env.MOLLIE_WEBHOOK_URL || "https://boxplanet.vercel.app/api/mollie-webhook",

      metadata: {
        firstName,
        lastName,
        email,
        streetAndNumber,
        postalCode,
        city,
        country,
        vatRate: rate,
        cart: normalizedCart,
        totalGross: to2(totalGross),
      },
    };

    // 1) Versuch: Klarna-Methoden (je nach Account heißen sie unterschiedlich)
    // Falls Mollie das ablehnt => Fallback ohne method.
    const klarnaMethodCandidates = [
      ["klarna"], // manche Accounts
      ["klarnapaylater", "klarnapaynow", "klarnasliceit"], // ältere Varianten (wenn verfügbar)
      ["paylater"], // selten
    ];

    let order = null;
    let lastMethodError = null;

    for (const methods of klarnaMethodCandidates) {
      try {
        order = await mollie.orders.create({
          ...baseOrderPayload,
          method: methods,
        });
        break;
      } catch (e) {
        lastMethodError = e;
      }
    }

    // 2) Wenn alles fehlschlägt: ohne method (Checkout funktioniert immer)
    if (!order) {
      try {
        order = await mollie.orders.create(baseOrderPayload);
      } catch (e) {
        console.error("Mollie order create failed:", e);
        return res.status(500).json({
          error: "Mollie order create failed",
          message: e.message,
          field: e.field,
          statusCode: e.statusCode,
          title: e.title,
          lastMethodError: lastMethodError ? {
            message: lastMethodError.message,
            field: lastMethodError.field,
            statusCode: lastMethodError.statusCode,
            title: lastMethodError.title,
          } : null,
        });
      }
    }

    const checkoutUrl = order?._links?.checkout?.href;
    if (!checkoutUrl) {
      return res.status(500).json({
        error: "No checkout URL returned",
        mollieResponse: order,
      });
    }

    return res.json({
      checkoutUrl,
      orderId: order.id,
      totalGross: to2(totalGross),
      // Debug-Hinweis: ob Klarna erzwungen wurde oder Fallback
      methodMode: order?._links ? "ok" : "unknown",
    });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: err.message,
      field: err.field,
      statusCode: err.statusCode,
      title: err.title,
    });
  }
};
