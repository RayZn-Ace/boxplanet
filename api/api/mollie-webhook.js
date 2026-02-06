export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const isProd = process.env.VERCEL_ENV === "production";
  const mollieKey = isProd
    ? process.env.MOLLIE_LIVE_KEY
    : process.env.MOLLIE_TEST_KEY;

  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFY_EMAIL;
  const fromEmail = process.env.FROM_EMAIL;

  const ok = () => res.status(200).end();

  if (!mollieKey) {
    console.log("Missing Mollie key for webhook", { isProd, vercelEnv: process.env.VERCEL_ENV });
    return ok();
  }

  // (Mail optional) – wenn du Mail willst, müssen die 3 Env Vars gesetzt sein
  const mailEnabled = !!(resendKey && notifyEmail && fromEmail);

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");

  const params = new URLSearchParams(raw);
  const orderId = params.get("id");
  if (!orderId) return ok();

  try {
    const r = await fetch(`https://api.mollie.com/v2/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${mollieKey}` }
    });

    const order = await r.json();

    if (!r.ok) {
      console.log("Mollie fetch error", order);
      return ok();
    }

    const status = order?.status;
    console.log("Mollie webhook update", { orderId, status, env: isProd ? "live" : "test" });

    const isConfirmed = status === "paid" || status === "completed";
    if (!isConfirmed) return ok();

    if (!mailEnabled) return ok();

    const email = order?.metadata?.email || "-";
    const productOption = order?.metadata?.productOption || "-";
    const net = order?.metadata?.net;
    const gross = order?.metadata?.gross;
    const amount = order?.amount?.value
      ? `${order.amount.value} ${order.amount.currency}`
      : "-";

    const subject = `✅ Ratenzahlung bestätigt (${isProd ? "LIVE" : "TEST"}): ${productOption} (${amount})`;

    const text = [
      "Ratenzahlung wurde bestätigt.",
      "",
      `ENV: ${isProd ? "LIVE" : "TEST"}`,
      `Order: ${orderId}`,
      `Status: ${status}`,
      `Betrag (Order): ${amount}`,
      gross ? `Brutto berechnet: ${gross} EUR` : null,
      net ? `Netto Auswahl: ${net} EUR` : null,
      `Produkt-Option: ${productOption}`,
      `Kunden-E-Mail: ${email}`,
      "",
      "Hinweis: Webhooks können mehrfach kommen. Falls du doppelte Mails bekommst, sag Bescheid – dann baue ich dir eine Duplikatsperre."
    ].filter(Boolean).join("\n");

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
      console.log("Resend error", rrData);
      return ok();
    }

    console.log("Resend sent", rrData);
    return ok();
  } catch (err) {
    console.log("Webhook error", String(err));
    return ok();
  }
}
