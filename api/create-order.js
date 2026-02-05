export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const key = process.env.MOLLIE_TEST_KEY;
  if (!key) return res.status(500).json({ error: "MOLLIE_TEST_KEY missing" });

  const {
    firstName,
    lastName,
    email,
    streetAndNumber,
    postalCode,
    city,
    country = "DE",
    productOption // <-- NEU: "coin" oder "coin_bill"
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

  // --- Preise (Netto) ---
  const PRODUCTS = {
    coin: {
      name: "Münzzähler",
      net: 1660.0
    },
    coin_bill: {
      name: "Münz & Scheinzähler",
      net: 1890.0
    }
  };

  const vatRate = 0.19; // 19% DE
  const selected = PRODUCTS[productOption];

  // Brutto für Ratenzahlung (Netto + 19%)
  const gross = +(selected.net * (1 + vatRate)).toFixed(2);

  // Mollie values müssen Strings mit 2 Dezimalstellen sein
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
        // Für Mollie Orders mit VAT ist es sauber, Gross/Net zu trennen:
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
    redirectUrl: "https://boxautomat.shop/zahlung-erfolg",
    webhookUrl: "https://boxplanet.vercel.app/api/mollie-webhook",
    metadata: {
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
        Authorization: `Bearer ${key}`,
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

    return res.status(200).json({ checkoutUrl, orderId: data.id, amountGross: grossStr });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
