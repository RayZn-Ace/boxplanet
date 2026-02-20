const createMollieClient = require("@mollie/api-client").default;

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
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.MOLLIE_API_KEY) {
      res.statusCode = 500;
      return res.json({ error: "Missing MOLLIE_API_KEY" });
    }

    const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

    const body = req.body || {};
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

    if (!firstName || !lastName || !email) {
      res.statusCode = 400;
      return res.json({ error: "Missing customer fields" });
    }

    const normalizedItems = [];

    if (Array.isArray(cart) && cart.length > 0) {
      for (const it of cart) {
        const option = String(it.productOption || "").trim();
        if (!option || !PRODUCT_CATALOG[option]) continue;
        normalizedItems.push({ option, qty: clampQuantity(it.quantity) });
      }
    } else {
      const option = String(productOption || "").trim();
      if (!option || !PRODUCT_CATALOG[option]) {
        res.statusCode = 400;
        return res.json({ error: "Invalid productOption" });
      }
      normalizedItems.push({ option, qty: clampQuantity(quantity) });
    }

    if (normalizedItems.length === 0) {
      res.statusCode = 400;
      return res.json({ error: "No valid cart items" });
    }

    const totalNetCents = normalizedItems.reduce((sum, it) => {
      const p = PRODUCT_CATALOG[it.option];
      return sum + p.unitPriceNetCents * it.qty;
    }, 0);

    if (!Number.isFinite(totalNetCents) || totalNetCents <= 0) {
      res.statusCode = 400;
      return res.json({ error: "Invalid total amount" });
    }

    const amountValue = toEurString(totalNetCents);

    const payment = await mollie.payments.create({
      amount: { currency: "EUR", value: amountValue },
      description: `Boxplanet Direktkauf (${normalizedItems.length} Position(en))`,
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

    const checkoutUrl = payment && payment.getCheckoutUrl && payment.getCheckoutUrl();
    if (!checkoutUrl) {
      res.statusCode = 500;
      return res.json({ error: "No checkoutUrl returned by Mollie" });
    }

    return res.json({ checkoutUrl, paymentId: payment.id });
  } catch (e) {
    console.error("CREATE_ORDER_ERROR:", e);
    res.statusCode = 500;
    return res.json({ error: "create-order failed", details: e?.message || String(e) });
  }
};
