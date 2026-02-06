export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const isProd = process.env.VERCEL_ENV === "production";

  const mollieKey = isProd
    ? process.env.MOLLIE_LIVE_KEY
    : process.env.MOLLIE_TEST_KEY;

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

  // Mollie sendet meistens x-www-form-urlencoded: id=ord_xxx
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);

  const orderId = params.get("id");
  if (!orderId) {
    console.log("Webhook: No order id in payload");
    return ok();
  }

  try {
    // Order-Status sicher bei Mollie nachschlagen
    const r = await fetch(`https://api.mollie.com/v2/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${mollieKey}` }
    });

    const order = await r.json();

    if (!r.ok) {
      console.log("Webhook: Mollie fetch error", order);
      return ok();
    }

    const status = order?.status;
    const amount = order?.amount?.value
      ? `${order.amount.value} ${order.amount.currency}`
      : "-";

    // ✅ Nur bei bestätigter Zahlung mailen
    const isConfirmed = status === "paid" || status === "completed";
    if (!isConfirmed) return ok();

    const email = order?.metadata?.email || "-";
    const productOption = order?.metadata?.productOption || "-";
    const net = order?.metadata?.net;
    const gross = order?.metadata?.gross;

    const subject = `✅ Zahlung eingegangen (${isProd ? "LIVE" : "TEST"}): ${productOption} (${amount})`;

    const text = [
      "Zahlung ist eingegangen.",
      "",
      `ENV: ${isProd ? "LIVE" : "TEST"}`,
      `Order ID: ${orderId}`,
      `Status: ${status}`,
      `Betrag: ${amount}`,
      gross ? `Brutto (berechnet): ${gross} EUR` : null,
      net ? `Netto (Auswahl): ${net} EUR` : null,
      `Produkt-Option: ${productOption}`,
      `Kunden-E-Mail: ${email}`,
      "",
      "Hinweis: Mollie kann Webhooks mehrfach senden. Wenn du doppelte Mails bekommst, sag Bescheid – dann baue ich eine Duplikatsperre."
    ].filter(Boolean).join("\n");

    // Mail senden via Resend
    const rr = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [notifyEmail],
        subject,
        text
      })
    });

    const rrData = await rr.json();

    if (!rr.ok) {
      console.log("Webhook: Resend error", rrData);
      return ok();
    }

    console.log("Webhook: Mail sent", rrData);
    return ok();
  } catch (err) {
    console.log("Webhook: Server error", String(err));
    return ok();
  }
}
