const createMollieClient = require("@mollie/api-client").default;

const clampMoney = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 100000) return null; // Sicherheitsdeckel
  return Math.round(n * 100) / 100; // 2 Dezimalstellen
};

const clampQuantity = (q) => {
  const n = Number(q);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 50);
};

const toEur = (value) => Number(value).toFixed(2);

module.exports = async (req, res) => {
  // CORS für Lovable
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Mollie Key (Vercel)
    const apiKey = process.env.MOLLIE_LIVE_KEY || process.env.MOLLIE_TEST_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "No Mollie key found",
        hint: "Set MOLLIE_LIVE_KEY or MOLLIE_TEST_KEY in Vercel",
      });
    }

    // Body robust parsen
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }
    body = body || {};

    const {
      firstName,
      lastName,
      email,
      streetAndNumber,
      postalCode,
      city,
      country = "DE",

      totalNet, // NETTO Gesamtwert vom Frontend
      vatRate = 19,

      cart = [], // optional: für Bestellbestätigung (Produkte + Mengen)
    } = body;

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: "Missing customer fields" });
    }

    const net = clampMoney(totalNet);
    if (net === null) {
      return res.status(400).json({ error: "Invalid totalNet" });
    }

    const rate = Number(vatRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 30) {
      return res.status(400).json({ error: "Invalid vatRate" });
    }

    // BRUTTO berechnen (19% drauf)
    const gross = Math.round(net * (1 + rate / 100) * 100) / 100;

    // cart normalisieren (nur für E-Mail/Metadata; Betrag kommt aus totalNet)
    const normalizedCart = Array.isArray(cart)
      ? cart
          .map((i) => ({
            productOption: String(i.productOption || "").trim(),
            quantity: clampQuantity(i.quantity),
          }))
          .filter((i) => i.productOption && i.quantity > 0)
      : [];

    const mollie = createMollieClient({ apiKey });

    const payment = await mollie.payments.create({
      amount: {
        currency: "EUR",
        value: toEur(gross), // BRUTTO an Mollie
      },
      description: "Boxplanet Direktkauf",
      redirectUrl: process.env.MOLLIE_REDIRECT_URL || "https://boxplanet.shop/checkout/success",
      webhookUrl: process.env.MOLLIE_WEBHOOK_URL || "https://boxplanet.vercel.app/api/mollie-webhook",
      metadata: {
        firstName,
        lastName,
        email,
        streetAndNumber: streetAndNumber || "",
        postalCode: postalCode || "",
        city: city || "",
        country: country || "DE",
        totalNet: toEur(net),
        vatRate: rate,
        totalGross: toEur(gross),
        cart: normalizedCart, // <-- Produkte + Mengen für Bestellbestätigung
      },
    });

    const checkoutUrl =
      (payment.getCheckoutUrl && payment.getCheckoutUrl()) ||
      payment?._links?.checkout?.href;

    if (!checkoutUrl) {
      return res.status(500).json({ error: "No checkout URL returned by Mollie" });
    }

    return res.json({
      checkoutUrl,
      paymentId: payment.id,
      totalNet: toEur(net),
      totalGross: toEur(gross),
    });
  } catch (err) {
    console.error("CREATE_ORDER_ERROR:", err);
    return res.status(500).json({
      error: "Payment creation failed",
      details: err?.message || String(err),
    });
  }
};
