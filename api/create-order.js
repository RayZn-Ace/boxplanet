export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const isProd = process.env.VERCEL_ENV === "production";

  const mollieKey = isProd
    ? process.env.MOLLIE_LIVE_KEY
    : process.env.MOLLIE_TEST_KEY;

  if (!mollieKey) {
    return res.status(500).json({
      error: "Missing Mollie key",
      expected: isProd ? "MOLLIE_LIVE_KEY" : "MOLLIE_TEST_KEY",
      vercelEnv: process.env.VERCEL_ENV
    });
  }

  const {
    firstName,
    lastName,
    email,
    streetAndNumber,
    postalCode,
    city,
    country = "DE",
    productOption
  } = req.body || {};

  if (!firstName || !lastName || !email || !streetAndNumber || !postalCode || !city) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!productOption || !["coin", "coin_bill"].includes(productOption)) {
    return res.status(400).json({
      error: "Missing or invalid productOption",
      expected: ["coin", "coin_bill"]
    });
  }

  // Preise (Netto)
  const PRODUCTS = {
    coin: { name: "Münzzähler", net: 1660.0 },
    coin_bill: { name: "Münz & Scheinzähler", net: 1890.0 }
  };

  const vatRate = 0.19;
  const selected = PRODUCTS[productOption];

  const gross = +(selected.net * (1 + vatRate)).toFixed(2);
  const grossStr = gross.toFixed(2);

  const vatAmount = +(gross - selected.net).toFixed(2);
  const vatAmountStr = vatAmount.toFixed(2);

  const payload = {
    locale: "de_DE",
    amount: { currency: "EUR", value: grossStr },
    orderNumber: `BP-${Date.now()}`,
    lines: [
      {
        type: "physical",
        name: `${selected.name} – Boxautomat`,
        quantity: 1,
        unitPrice: { currency: "EUR", value: grossStr },
        totalAmount: { currency: "EUR", value: grossStr },
        vatRate: "19.00",
        vatAmount: { currency: "EUR", value: vatAmountStr }
      }
    ],
    billingAddress: {
      givenName: firstName,
      familyName: lastName,
      email,
      streetAndNumber,
      postalCode,
      city,
      country
    },
    shippingAddress: {
      givenName: firstName,
      familyName: lastName,
      email,
      streetAndNumber,
      postalCode,
      city,
      country
    },

    // ✅ Deine Live-Domain
    redirectUrl: "https://boxautomat.shop/zahlung-erfolg",

    // ✅ Webhook bleibt deine Vercel-API
    webhookUrl: "https://boxplanet.vercel.app/api/mollie-webhook",

    metadata: {
      env: isProd ? "live" : "test",
      email,
      productOption,
      net: selected.net,
      gross
    }
  };

  try {
    const response = await fetch("https://api.mollie.com/v2/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mollieKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({ error: "Mollie error", details: data });
    }

    const checkoutUrl = data?._links?.checkout?.href;
    if (!checkoutUrl) {
      return res.status(500).json({ error: "No checkoutUrl returned", data });
    }

    return res.status(200).json({
      checkoutUrl,
      orderId: data.id,
      amountGross: grossStr,
      env: isProd ? "live" : "test"
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
