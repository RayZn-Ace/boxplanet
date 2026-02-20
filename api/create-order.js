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
      return res.status(400).json({
        error: "Missing customer fields",
        received: body,
      });
    }

    if (!streetAndNumber || !postalCode || !city) {
      return res.status(400).json({
        error: "Missing address fields",
        received: body,
      });
    }

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({
        error: "Cart missing or empty",
        received: body,
      });
    }

    const normalizedCart = cart
      .map((item) => ({
        productOption: String(item.productOption || "").trim(),
        quantity: clampQuantity(item.quantity),
      }))
      .filter(
        (item) =>
          item.productOption &&
          PRODUCT_CATALOG[item.productOption] &&
          item.quantity > 0
      );

    if (normalizedCart.length === 0) {
      return res.status(400).json({
        error: "Cart invalid after normalization",
        normalizedCart,
        received: body,
      });
    }

    const rate = Number(vatRate);
    if (!Number.isFinite(rate)) {
      return res.status(400).json({
        error: "Invalid VAT rate",
        received: body,
      });
    }

    const lines = normalizedCart.map((item) => {
      const product = PRODUCT_CATALOG[item.productOption];
      const netTotal = product.net * item.quantity;
      const grossTotal = netTotal * (1 + rate / 100);
      const vatAmount = grossTotal - netTotal;

      return {
        name: product.name,
        quantity: item.quantity,
        unitPrice: {
          currency: "EUR",
          value: to2(product.net * (1 + rate / 100)),
        },
        totalAmount: {
          currency: "EUR",
          value: to2(grossTotal),
        },
        vatRate: to2(rate),
        vatAmount: {
          currency: "EUR",
          value: to2(vatAmount),
        },
        category: "physical",
        sku: item.productOption,
      };
    });

    const totalGross = lines.reduce(
      (sum, line) => sum + Number(line.totalAmount.value),
      0
    );

    const mollie = createMollieClient({ apiKey });

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
      redirectUrl:
        process.env.MOLLIE_REDIRECT_URL ||
        "https://boxplanet.shop/checkout/success",
      webhookUrl:
        process.env.MOLLIE_WEBHOOK_URL ||
        "https://boxplanet.vercel.app/api/mollie-webhook",
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
      },
    });

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
    });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: err.message,
      stack: err.stack,
    });
  }
};
