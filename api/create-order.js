export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const key = process.env.MOLLIE_TEST_KEY;
  if (!key) {
    return res.status(500).json({ error: "MOLLIE_TEST_KEY missing" });
  }

  const {
    firstName,
    lastName,
    email,
    streetAndNumber,
    postalCode,
    city,
    country = "DE"
  } = req.body || {};

  if (
    !firstName ||
    !lastName ||
    !email ||
    !streetAndNumber ||
    !postalCode ||
    !city
  ) {
    return res.status(400).json({
      error: "Missing required fields"
    });
  }

  const payload = {
    locale: "de_DE",
    amount: {
      currency: "EUR",
      value: "1675.00"
    },
    orderNumber: `BP-${Date.now()}`,
    lines: [
      {
        type: "physical",
        name: "Champion Boxing – Boxautomat",
        quantity: 1,
        unitPrice: {
          currency: "EUR",
          value: "1675.00"
        },
        totalAmount: {
          currency: "EUR",
          value: "1675.00"
        },
        vatRate: "0.00",
        vatAmount: {
          currency: "EUR",
          value: "0.00"
        }
      }
    ],
    billingAddress: {
      givenName: firstName,
      familyName: lastName,
      email: email,
      streetAndNumber: streetAndNumber,
      postalCode: postalCode,
      city: city,
      country: country
    },
    shippingAddress: {
      givenName: firstName,
      familyName: lastName,
      email: email,
      streetAndNumber: streetAndNumber,
      postalCode: postalCode,
      city: city,
      country: country
    },
    redirectUrl: "https://boxautomat.shop/zahlung-erfolg",
    webhookUrl: "https://boxplanet.vercel.app/api/mollie-webhook",
    metadata: {
      email: email
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
      return res.status(400).json({
        error: "Mollie error",
        details: data
      });
    }

    const checkoutUrl = data?._links?.checkout?.href;

    if (!checkoutUrl) {
      return res.status(500).json({
        error: "No checkoutUrl returned",
        data
      });
    }

    return res.status(200).json({
      checkoutUrl: checkoutUrl,
      orderId: data.id
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err)
    });
  }
}
