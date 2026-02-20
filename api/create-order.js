const createMollieClient = require("@mollie/api-client").default;

const PRODUCT_CATALOG = {
  coin: { name: "Münzzähler", priceCents: 1660 * 100 },
  cash: { name: "Münz & Scheinzähler", priceCents: 1890 * 100 },
};

const clampQuantity = (q) => {
  const n = Number(q);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 50);
};

const toEur = (cents) => (cents / 100).toFixed(2);

module.exports = async (req, res) => {
  // CORS für Lovable
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 🔥 HIER DER FIX
    const apiKey =
      process.env.MOLLIE_LIVE_KEY ||
      process.env.MOLLIE_TEST_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "No Mollie key found",
        hint: "Check MOLLIE_LIVE_KEY or MOLLIE_TEST_KEY in Vercel"
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }

    const { firstName, lastName, email, productOption, quantity } = body || {};

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: "Missing customer fields" });
    }

    if (!PRODUCT_CATALOG[productOption]) {
      return res.status(400).json({ error: "Invalid productOption" });
    }

    const qty = clampQuantity(quantity);
    const totalCents = PRODUCT_CATALOG[productOption].priceCents * qty;

    const mollie = createMollieClient({ apiKey });

    const payment = await mollie.payments.create({
      amount: {
        currency: "EUR",
        value: toEur(totalCents),
      },
      description: "Boxplanet Direktkauf",
      redirectUrl: "https://boxplanet.shop/checkout/success",
      webhookUrl: "https://boxplanet.vercel.app/api/mollie-webhook",
      metadata: {
        firstName,
        lastName,
        email,
        productOption,
        quantity: qty,
      },
    });

    const checkoutUrl =
      (payment.getCheckoutUrl && payment.getCheckoutUrl()) ||
      payment?._links?.checkout?.href;

    if (!checkoutUrl) {
      return res.status(500).json({ error: "No checkout URL returned" });
    }

    return res.json({
      checkoutUrl,
      paymentId: payment.id,
    });

  } catch (err) {
    console.error("CREATE_ORDER_ERROR:", err);
    return res.status(500).json({
      error: "Payment creation failed",
      details: err.message,
    });
  }
};
