import type { NextApiRequest, NextApiResponse } from "next";
import createMollieClient from "@mollie/api-client";

/**
 * WICHTIG:
 * - Preise NICHT aus dem Frontend übernehmen.
 * - Mappe productOption -> serverseitige Preise.
 * - Rechne in CENT (Integer), danach wieder in EUR-String.
 */

// Passe diese Map an eure echten productOption-Werte an (coin / cash / etc.)
const PRODUCT_CATALOG: Record<
  string,
  { name: string; unitPriceNetCents: number; vatRate?: string }
> = {
  coin: { name: "Münzzähler", unitPriceNetCents: 1660 * 100, vatRate: "19.00" },
  cash: { name: "Münz & Scheinzähler", unitPriceNetCents: 1890 * 100, vatRate: "19.00" },
};

// defensives Limit, damit niemand 99999 bestellt
const clampQuantity = (q: unknown) => {
  const n = Number(q);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 50);
};

const toEurString = (cents: number) => (cents / 100).toFixed(2);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY! });

    const {
      firstName,
      lastName,
      email,
      streetAndNumber,
      postalCode,
      city,
      country = "DE",
      productOption,
      quantity,
      cart,
    } = req.body ?? {};

    // Basic required field checks (halte sie so wie ihr es braucht)
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: "Missing customer fields" });
    }

    // 1) Wenn cart[] mitkommt: multi-item
    // 2) Sonst: fallback single item via productOption + quantity
    type CartItem = {
      productOption?: string;
      quantity?: number;
    };

    const normalizedItems: { option: string; qty: number }[] = [];

    if (Array.isArray(cart) && cart.length > 0) {
      for (const it of cart as CartItem[]) {
        const option = String(it.productOption ?? "").trim();
        if (!option || !PRODUCT_CATALOG[option]) continue;
        normalizedItems.push({ option, qty: clampQuantity(it.quantity) });
      }
    } else {
      const option = String(productOption ?? "").trim();
      if (!option || !PRODUCT_CATALOG[option]) {
        return res.status(400).json({ error: "Invalid productOption" });
      }
      normalizedItems.push({ option, qty: clampQuantity(quantity) });
    }

    if (normalizedItems.length === 0) {
      return res.status(400).json({ error: "No valid cart items" });
    }

    // Serverseitig Total berechnen (NETTO in Cent)
    const totalNetCents = normalizedItems.reduce((sum, it) => {
      const p = PRODUCT_CATALOG[it.option];
      return sum + p.unitPriceNetCents * it.qty;
    }, 0);

    // NOTE:
    // Ihr zeigt im Frontend NETTO. Mollie "amount" ist einfach ein Betrag.
    // Wenn ihr BRUTTO berechnen müsst, hier VAT aufschlagen und totalGrossCents nutzen.
    // Beispiel (19%): gross = net * 1.19
    // Ich lasse es hier NETTO, weil eure UI auch NETTO zeigt.
    const amountValue = toEurString(totalNetCents);

    // ---- MOLLIE PAYMENT (einfachster Weg) ----
    // Wenn ihr Mollie Orders nutzt, siehe Variante B weiter unten.
    const payment = await mollie.payments.create({
      amount: { currency: "EUR", value: amountValue },
      description: `Boxplanet Direktkauf (${normalizedItems.length} Position(en))`,
      // URLs anpassen:
      redirectUrl: process.env.MOLLIE_REDIRECT_URL || "https://boxplanet.shop/checkout/success",
      webhookUrl: process.env.MOLLIE_WEBHOOK_URL || "https://boxplanet.vercel.app/api/mollie-webhook",
      metadata: {
        customer: { firstName, lastName, email, streetAndNumber, postalCode, city, country },
        items: normalizedItems.map((it) => ({
          productOption: it.option,
          quantity: it.qty,
          name: PRODUCT_CATALOG[it.option].name,
          unitPriceNet: toEurString(PRODUCT_CATALOG[it.option].unitPriceNetCents),
        })),
        totalNet: amountValue,
      },
    });

    return res.status(200).json({
      ok: true,
      checkoutUrl: payment.getCheckoutUrl(),
      paymentId: payment.id,
      amount: payment.amount,
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e?.message ?? String(e) });
  }
}
