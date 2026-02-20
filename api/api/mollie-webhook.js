export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const isProd = process.env.VERCEL_ENV === "production";
  const mollieKey = isProd ? process.env.MOLLIE_LIVE_KEY : process.env.MOLLIE_TEST_KEY;

  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFY_EMAIL;
  const fromEmail = process.env.FROM_EMAIL;

  // Mollie erwartet 200, sonst wird der Webhook wiederholt
  const ok = () => res.status(200).end();

  if (!mollieKey) {
    console.log("Webhook: Missing Mollie key", { vercelEnv: process.env.VERCEL_ENV });
    return ok();
  }

  if (!resendKey || !notifyEmail || !fromEmail) {
    console.log("Webhook: Missing email env vars", {
      hasResend: !!resendKey,
      hasNotify: !!notifyEmail,
      hasFrom: !!fromEmail
    });
    return ok();
  }

  // Mollie sendet meist x-www-form-urlencoded: id=tr_xxx
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);

  const paymentId = params.get("id");
  if (!paymentId) {
    console.log("Webhook: No id in payload");
    return ok();
  }

  // Nur Payments in diesem Setup
  if (!paymentId.startsWith("tr_")) {
    console.log("Webhook: Ignored non-payment id", { paymentId });
    return ok();
  }

  try {
    // Payment sicher bei Mollie nachschlagen
    const r = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${mollieKey}` }
    });

    const payment = await r.json();

    if (!r.ok) {
      console.log("Webhook: Mollie fetch error", payment);
      return ok();
    }

    const status = payment?.status; // paid / open / failed / etc.
    const amount = payment?.amount?.value
      ? `${payment.amount.value} ${payment.amount.currency}`
      : "-";

    // ✅ Nur bei bestätigter Zahlung mailen
    if (status !== "paid") return ok();

    const md = payment?.metadata || {};
    const customerEmail = md?.email || "";
    const fullName = [md?.firstName, md?.lastName].filter(Boolean).join(" ").trim() || "Kunde";

    const totalNet = md?.totalNet || "-";
    const totalGross = md?.totalGross || payment?.amount?.value || "-";
    const vatRate = md?.vatRate ?? 19;

    const addressLine = [md?.streetAndNumber, md?.postalCode, md?.city]
      .filter(Boolean)
      .join(", ");

    // Produkte & Mengen (aus metadata.cart)
    const cart = Array.isArray(md?.cart) ? md.cart : [];
    const niceName = (opt) => {
      if (opt === "coin") return "Münzzähler";
      if (opt === "cash") return "Münz & Scheinzähler";
      return opt || "-";
    };

    const productLines = cart.length
      ? cart.map((i) => `- ${i.quantity} x ${niceName(i.productOption)}`).join("\n")
      : "- (keine Positionsdaten übermittelt)";

    // -----------------
    // ADMIN MAIL
    // -----------------
    const adminSubject = `✅ Zahlung eingegangen (${isProd ? "LIVE" : "TEST"}): ${amount}`;
    const adminText = [
      "Zahlung ist eingegangen.",
      "",
      `ENV: ${isProd ? "LIVE" : "TEST"}`,
      `Payment ID: ${paymentId}`,
      `Status: ${status}`,
      `Betrag (Mollie): ${amount}`,
      "",
      "Produkte:",
      productLines,
      "",
      `Netto: ${totalNet} EUR`,
      `MwSt: ${vatRate}%`,
      `Brutto: ${totalGross} EUR`,
      "",
      `Kunde: ${fullName}`,
      `Kunden-E-Mail: ${customerEmail || "-"}`,
      addressLine ? `Adresse: ${addressLine}` : null,
      "",
      "Hinweis: Mollie kann Webhooks mehrfach senden. Wenn du doppelte Mails bekommst, sag Bescheid – dann baue ich eine Duplikatsperre."
    ].filter(Boolean).join("\n");

    const rrAdmin = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [notifyEmail],
        subject: adminSubject,
        text: adminText
      })
    });

    const rrAdminData = await rrAdmin.json();
    if (!rrAdmin.ok) {
      console.log("Webhook: Resend admin error", rrAdminData);
      return ok();
    }

    // -----------------
    // CUSTOMER MAIL
    // -----------------
    if (customerEmail && customerEmail.includes("@")) {
      const customerSubject = "✅ Bestellbestätigung – Boxplanet Direktkauf";
      const customerText = [
        `Hallo ${fullName},`,
        "",
        "vielen Dank! Wir haben deine Zahlung erfolgreich erhalten.",
        "",
        "Deine Bestellung:",
        productLines,
        "",
        `Netto: ${totalNet} EUR`,
        `MwSt: ${vatRate}%`,
        `Brutto: ${totalGross} EUR`,
        "",
        `Payment ID: ${paymentId}`,
        addressLine ? `Adresse: ${addressLine}` : null,
        "",
        "Wenn du Fragen hast, antworte einfach auf diese E-Mail.",
        "",
        "Mit freundlichen Grüßen",
        "Boxplanet"
      ].filter(Boolean).join("\n");

      const rrCustomer = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [customerEmail],
          subject: customerSubject,
          text: customerText
        })
      });

      const rrCustomerData = await rrCustomer.json();
      if (!rrCustomer.ok) {
        console.log("Webhook: Resend customer error", rrCustomerData);
        return ok();
      }

      console.log("Webhook: Admin+Customer mail sent", { rrAdminData, rrCustomerData });
      return ok();
    }

    console.log("Webhook: Admin mail sent, customer email missing/invalid", rrAdminData);
    return ok();
  } catch (err) {
    console.log("Webhook: Server error", String(err));
    return ok();
  }
}
