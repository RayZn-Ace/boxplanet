export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const isProd = process.env.VERCEL_ENV === "production";
  const mollieKey = isProd ? process.env.MOLLIE_LIVE_KEY : process.env.MOLLIE_TEST_KEY;

  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFY_EMAIL;
  const fromEmail = process.env.FROM_EMAIL;

  const ok = () => res.status(200).end();

  if (!mollieKey) return ok();
  if (!resendKey || !notifyEmail || !fromEmail) return ok();

  // Mollie sendet oft x-www-form-urlencoded: id=ord_xxx oder id=tr_xxx
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);

  const id = params.get("id");
  if (!id) return ok();

  const niceName = (opt) => {
    if (opt === "coin") return "Münzzähler";
    if (opt === "cash") return "Münz & Scheinzähler";
    return opt || "-";
  };

  const sendResend = async ({ to, subject, text }) => {
    const rr = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromEmail, to: [to], subject, text }),
    });
    const data = await rr.json().catch(() => ({}));
    if (!rr.ok) console.log("Resend error:", data);
    return rr.ok;
  };

  try {
    // ---- ORDER FLOW (ord_) ----
    if (id.startsWith("ord_")) {
      const r = await fetch(`https://api.mollie.com/v2/orders/${id}`, {
        headers: { Authorization: `Bearer ${mollieKey}` },
      });

      const order = await r.json();
      if (!r.ok) return ok();

      const status = order?.status; // paid / completed / authorized etc.
      const isConfirmed = status === "paid" || status === "completed";
      if (!isConfirmed) return ok();

      const md = order?.metadata || {};
      const customerEmail = md?.email || "";
      const fullName = [md?.firstName, md?.lastName].filter(Boolean).join(" ").trim() || "Kunde";
      const addressLine = [md?.streetAndNumber, md?.postalCode, md?.city].filter(Boolean).join(", ");

      const totalNet = md?.totalNet || "-";
      const totalGross = md?.totalGross || order?.amount?.value || "-";
      const vatRate = md?.vatRate ?? 19;

      const cart = Array.isArray(md?.cart) ? md.cart : [];
      const productLines = cart.length
        ? cart.map((i) => `- ${i.quantity} x ${niceName(i.productOption)}`).join("\n")
        : "- (keine Positionsdaten)";

      // Admin
      await sendResend({
        to: notifyEmail,
        subject: `✅ Zahlung eingegangen (${isProd ? "LIVE" : "TEST"}): ${totalGross} EUR (Order)`,
        text: [
          "Zahlung ist eingegangen (Order).",
          "",
          `ENV: ${isProd ? "LIVE" : "TEST"}`,
          `Order ID: ${id}`,
          `Status: ${status}`,
          "",
          "Produkte:",
          productLines,
          "",
          `Netto: ${totalNet} EUR`,
          `MwSt: ${vatRate}%`,
          `Brutto: ${totalGross} EUR`,
          "",
          `Kunde: ${fullName}`,
          `E-Mail: ${customerEmail || "-"}`,
          addressLine ? `Adresse: ${addressLine}` : null,
        ].filter(Boolean).join("\n"),
      });

      // Kunde
      if (customerEmail && customerEmail.includes("@")) {
        await sendResend({
          to: customerEmail,
          subject: "✅ Bestellbestätigung – Boxplanet Direktkauf",
          text: [
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
            `Order ID: ${id}`,
            addressLine ? `Adresse: ${addressLine}` : null,
            "",
            "Mit freundlichen Grüßen",
            "Boxplanet",
          ].filter(Boolean).join("\n"),
        });
      }

      return ok();
    }

    // ---- PAYMENT FLOW (tr_) Fallback ----
    if (id.startsWith("tr_")) {
      const r = await fetch(`https://api.mollie.com/v2/payments/${id}`, {
        headers: { Authorization: `Bearer ${mollieKey}` },
      });

      const payment = await r.json();
      if (!r.ok) return ok();
      if (payment?.status !== "paid") return ok();

      const md = payment?.metadata || {};
      const customerEmail = md?.email || "";
      const fullName = [md?.firstName, md?.lastName].filter(Boolean).join(" ").trim() || "Kunde";
      const totalGross = md?.totalGross || payment?.amount?.value || "-";

      await sendResend({
        to: notifyEmail,
        subject: `✅ Zahlung eingegangen (${isProd ? "LIVE" : "TEST"}): ${totalGross} EUR (Payment)`,
        text: [
          "Zahlung ist eingegangen (Payment).",
          `Payment ID: ${id}`,
          `Kunde: ${fullName} (${customerEmail || "-"})`,
        ].join("\n"),
      });

      return ok();
    }

    return ok();
  } catch (err) {
    console.log("Webhook error:", String(err));
    return ok();
  }
}
