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

const calcLine = ({ productOption, quantity, vatRate }) => {
  const p = PRODUCT_CATALOG[productOption];
  const qty = clampQuantity(quantity);

  const netTotal = p.net * qty;
  const grossTotal = netTotal * (1 + vatRate / 100);
  const vatAmount = grossTotal - netTotal;

  // Mollie Orders API erwartet Strings mit 2 Nachkommastellen
  return {
    name: p.name,
    quantity: qty,
    unitPrice: { currency: "EUR", value: to2(p.net * (1 + vatRate / 100)) }, // BRUTTO je Stück
    totalAmount: { currency: "EUR", value: to2(grossTotal) },               // BRUTTO gesamt
    vatRate: to2(vatRate),
    vatAmount: { currency: "EUR", value: to2(vatAmount) },
    category: "physical",
    sku: productOption,
  };
};

module.exports = async (req, res) => {
  // CORS für Lovable
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
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
      vatRate = 19,

      // Lovable soll cart mitsenden (für Klarna/Orderlines + Mail)
      cart = [],
    } = body;

    if (!firstName || !lastName || !email || !streetAndNumber || !postalCode || !city) {
      return res.status(400).json({ error: "Missing required customer/address fields" });
    }

    const rate = Number(vatRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 30) {
      return res.status(400).json({ error: "Invalid vatRate" });
    }

    const normalizedCart = Array.isArray(cart)
      ? cart
          .map((i) => ({
            productOption: String(i.productOption || "").trim(),
            quantity: clampQuantity(i.quantity),
          }))
          .filter((i) => i.productOption && PRODUCT_CATALOG[i.productOption] && i.quantity > 0)
      : [];

    if (normalizedCart.length === 0) {
      return res.status(400).json({ error: "Cart is empty or invalid" });
    }

    // Lines + Totals aus cart berechnen (serverseitig korrekt, keine Frontend-Abweichung)
    const lines = normalizedCart.map((it) => calcLine({ ...it, vatRate: rate }));

    const totalGross = lines.reduce((sum, l) => sum + Number(l.totalAmount.value), 0);
    const totalNet = normalizedCart.reduce((sum, it) => sum + PRODUCT_CATALOG[it.productOption].net * it.quantity, 0);

    const mollie = createMollieClient({ apiKey });

    // ✅ Klarna zuverlässig: Orders + vollständige Adresse + Lines
    // Methode: "klarna" (neuer, einheitlicher Klarna-Checkout – Raten/Pay later je nach Klarna-Optionen im Checkout)
    const order = await mollie.orders.create({
      amount: { currency: "EUR", value: to2(totalGross) },
      orderNumber: `BP-${Date.now()}`,
      locale: "de_DE",
      method: ["klarna", "card"],

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
        totalNet: to2(totalNet),
        totalGross: to2(totalGross),
        cart: normalizedCart,
      },
    });

    const checkoutUrl = order?._links?.checkout?.href;
    if (!checkoutUrl) {
      return res.status(500).json({ error: "No checkout URL returned by Mollie (order)" });
    }

    return res.json({
      checkoutUrl,
      orderId: order.id,
      totalNet: to2(totalNet),
      totalGross: to2(totalGross),
    });
  } catch (err) {
    console.error("CREATE_ORDER_ERROR:", err);
    return res.status(500).json({
      error: "Order creation failed",
      details: err?.message || String(err),
    });
  }
};
