const createMollieClient = require("@mollie/api-client").default;

/**
 * Serverseitiger Produktkatalog (NETTO in Cent).
 * Passe die Keys "coin" / "cash" exakt an eure productOption-Werte an!
 */
const PRODUCT_CATALOG = {
  coin: { name: "Münzzähler", unitPriceNetCents: 1660 * 100 },
  cash: { name: "Münz & Scheinzähler", unitPriceNetCents: 1890 * 100 },
};

const clampQuantity = (q) => {
  const n = Number(q);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 50);
};

const toEurString = (cents) => (cents / 100).toFixed(2);

module.exports = async (req, res) => {
  /* =========================
     1) CORS / PREFLIGHT
  ========================== */
  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "https://boxplanet.shop",
    "https://www.boxplanet.shop",
    "http://localhost:3000",
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    // Preflight OK
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "Method not allowed", method: req.method });
  }

  /* =========================
     2) BODY PARSING (Vercel)
  ========================== */
  let body = req.body;

  // Manche Vercel-Setups liefern req.body als String
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }

  body = body || {};

  // Debug (siehst du in Vercel Functions Logs)
  console.log("CREATE_ORDER_METHOD:", req.method);
  console.log("CREATE_ORDER_BODY:", body);

  /* =========================
     3) ORDER LOGIC
  ========================== */
  try {
    if (!process.env.MOLLIE_API_KEY) {
      res.statusCode = 500;
      return res.json({ error: "Missing MOLLIE_API_KEY" });
    }

    const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

    const {
      firstName,
      lastName,
      email,
      streetAndNumber,
      postalCode,
      city,
      country = "DE",
      productOption,
      quantity,
      cart,
    } = body;

    // Minimal required fields (falls Checkout mehr braucht, erweitern)
    if (!firstName || !lastName || !email) {
      res.statusCode = 400;
      return res.json({ error: "Missing customer fields" });
    }

    /**
     * normalizedItems:
     * - wenn cart[] vorhanden: mehrere Positionen
     * - sonst: single productOption + quantity
     */
    const normalizedItems = [];

    if (Array.isArray(cart) && cart.length > 0) {
      for (const item of cart) {
        const option = String(item.productOption || "").trim();
        if (!option || !PRODUCT_CATALOG[option]) continue;

        normalizedItems.push({
          option,
          qty: clampQuantity(item.quantity),
        });
      }
    } else {
      const option = String(productOption || "").trim();
      if (!option || !PRODUCT_CATALOG[option]) {
        res.statusCode = 400;
        return res.json({ error: "Invalid productOption" });
      }

      normalizedItems.push({
        option,
        qty: clampQuantity(quantity),
      });
    }

    if (normalizedItems.length === 0) {
      res.statusCode = 400;
      return res.json({ error: "No valid cart items" });
    }

    // Total (NETTO) in Cent
    const totalNetCents = normalizedItems.reduce((sum, item) => {
      const product = PRODUCT_CATALOG[item.option];
      return sum + product.unitPriceNetCents * item.qty;
    }, 0);

    if (!Number.isFinite(totalNetCents) || totalNetCents <= 0) {
      res.statusCode = 400;
      return res.json({ error: "Invalid total amount" });
    }

    const amountValue = toEurString(totalNetCents);

    // Mollie Payment anlegen
    const payment = await mollie.payments.create({
      amount: { currency: "EUR", value: amountValue },
      description: "Boxplanet Direktkauf",
      redirectUrl:
        process.env.MOLLIE_REDIRECT_URL ||
        "https://boxplanet.shop/checkout/success",
      webhookUrl:
        process.env.MOLLIE_WEBHOOK_URL ||
        "https://boxplanet.vercel.app/api/mollie-webhook",
      metadata: {
        customer: {
          firstName,
          lastName,
          email,
          streetAndNumber,
          postalCode,
          city,
          country,
        },
        items: normalizedItems.map((it) => ({
          productOption: it.option,
          quantity: it.qty,
          name: PRODUCT_CATALOG[it.option].name,
          unitPriceNet: toEurString(PRODUCT_CATALOG[it.option].unitPriceNetCents),
        })),
        totalNet: amountValue,
      },
    });

    const checkoutUrl =
      payment && payment.getCheckoutUrl && payment.getCheckoutUrl();

    if (!checkoutUrl) {
      res.statusCode = 500;
      return res.json({ error: "No checkoutUrl returned by Mollie" });
    }

    // Kompatible Response Keys (falls Frontend andere Keys erwartet)
    return res.json({
      ok: true,
      checkoutUrl,
      url: checkoutUrl,
      paymentUrl: checkoutUrl,
      paymentId: payment.id,
      amount: payment.amount,
    });
  } catch (error) {
    console.error("CREATE_ORDER_ERROR:", error);
    res.statusCode = 500;
    return res.json({
      error: "create-order failed",
      details: error?.message || String(error),
    });
  }
};
