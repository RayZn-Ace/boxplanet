export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const key = process.env.MOLLIE_TEST_KEY;
  if (!key) return res.status(500).end();

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");

  const params = new URLSearchParams(raw);
  const orderId = params.get("id");
  if (!orderId) return res.status(200).end();

  const r = await fetch(`https://api.mollie.com/v2/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  const order = await r.json();

  console.log("Order status:", order.status, order.metadata?.email);
  return res.status(200).end();
}
