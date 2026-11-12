// Buyer and seller agents.
// Sellers are real HTTP services (mounted at /seller/*) that receive the signed
// agreement and return a deliverable. The buyer agent drafts the agreement,
// calls the seller over HTTP, and hands the delivery to verification.
import { readFileSync } from "node:fs";
import { getPurchase, readArtifact } from "./store.js";

export const SELLERS = {
  ledgerline: {
    id: "ledgerline", name: "Ledgerline Data", tagline: "Curated fintech decision-maker contacts",
    file: "datasets/ledgerline.csv", unit_price_cents: 1, quantity: 1000,
  },
  leadsprint: {
    id: "leadsprint", name: "LeadSprint", tagline: "Fast B2B lead lists, scraped daily",
    file: "datasets/leadsprint.csv", unit_price_cents: 1, quantity: 1000,
  },
  bulkreach: {
    id: "bulkreach", name: "BulkReach", tagline: "Million-contact bulk lists, cheap",
    file: "datasets/bulkreach.csv", unit_price_cents: 1, quantity: 1000,
  },
};

export const SCHEMA = ["id", "company", "contact_name", "title", "email", "phone", "country", "website"];

export function draftAgreement({ seller, quantity, unit_price_cents, review_mode, purpose, allowed_countries, min_acceptance_ratio }) {
  return {
    version: "agentkee-agreement/1.0",
    product: "B2B contact records",
    seller: { id: seller.id, name: seller.name },
    quantity,
    unit_price_cents,
    currency: "USD",
    review_mode: review_mode === "always" ? "always" : "auto",
    criteria: {
      schema: SCHEMA,
      required_fields: ["company", "contact_name", "title", "email", "phone", "country", "website"],
      allowed_countries: allowed_countries || ["US", "GB", "CA", "NG", "KE", "ZA", "GH"],
      email_matches_website: true,
      min_acceptance_ratio: min_acceptance_ratio ?? 0.5,
      purpose: purpose || "senior decision-makers (founders, C-level, VPs, heads of department) at fintech and payments companies",
    },
    payment_terms:
      "Buyer authorizes the full amount. Seller is paid only for records that pass every acceptance rule. " +
      "If fewer than min_acceptance_ratio pass, the delivery is rejected and the authorization voided.",
  };
}

// --- Seller service (HTTP handlers) ---
export function mountSellers(app) {
  app.get("/seller/catalog", (_req, res) => {
    res.json(Object.values(SELLERS).map(({ file, ...s }) => s));
  });
  app.post("/seller/:id/fulfill", (req, res) => {
    const { agreement, purchase_id } = req.body || {};
    if (!agreement || !purchase_id) return res.status(400).json({ error: "agreement and purchase_id required" });
    if (req.params.id === "custom") {
      // "Bring your own file": a human acting as the seller uploaded this delivery.
      const p = getPurchase(purchase_id);
      const csv = p?.custom_delivery_path ? readArtifact(p.custom_delivery_path) : null;
      if (!csv) return res.status(404).json({ error: "No uploaded delivery for this purchase" });
      return res.type("text/csv").send(csv);
    }
    const s = SELLERS[req.params.id];
    if (!s) return res.status(404).json({ error: "Unknown seller" });
    res.type("text/csv").send(readFileSync(s.file, "utf8"));
  });
}

// --- Buyer agent: request delivery from the seller over HTTP ---
export async function requestDelivery(selfBase, purchase) {
  const r = await fetch(`${selfBase}/seller/${purchase.agreement.seller.id}/fulfill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agreement: purchase.agreement, purchase_id: purchase.id }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Seller responded ${r.status}: ${text.slice(0, 200)}`);
  return { csv: text, bytes: Buffer.byteLength(text), content_type: r.headers.get("content-type") };
}
