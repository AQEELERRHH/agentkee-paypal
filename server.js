// AgentKee — pay AI-agent purchases only for what was actually delivered.
// PayPal (sandbox) authorize -> seller delivers -> deterministic verification
// -> AI semantic check -> deterministic decision -> PayPal capture / partial
// capture / void -> verified against PayPal's own records.
import { loadEnv, centsToStr } from "./lib/env.js";
loadEnv();

import express from "express";
import * as store from "./lib/store.js";
import * as paypal from "./lib/paypal.js";
import { verifyDelivery, verifyRecords } from "./lib/verify.js";
import { decide } from "./lib/decide.js";
import { assess, aiInfo } from "./lib/ai.js";
import { SELLERS, draftAgreement, mountSellers, requestDelivery } from "./lib/agents.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SELF = `http://127.0.0.1:${PORT}`;

const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(express.static("public"));
app.use("/datasets", express.static("datasets"));
// AG Grid Community (MIT), served locally so the demo never depends on a CDN.
app.get("/vendor/ag-grid-community.min.js", (_req, res) => res.sendFile("ag-grid-community.min.js", { root: "node_modules/ag-grid-community/dist" }));
mountSellers(app);

// ---------- helpers ----------
const sandboxLink = (kind, id) =>
  paypal.isSandbox() ? `https://www.sandbox.paypal.com/activity/payment/${id}` : `https://www.paypal.com/activity/payment/${id}`;

function errInfo(e) {
  return { message: e.message, status: e.status || null, debug_id: e.debug_id || null, paypal: e.body || null };
}

function fail(id, step, e) {
  const info = errInfo(e);
  store.addEvent(id, "error", "system", { step, ...info });
  store.updatePurchase(id, { state: "FAILED", failure: { step, ...info, at: new Date().toISOString() } });
}

const running = new Set();

// ---------- pipeline: runs after PayPal authorization ----------
async function runPipeline(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    let p = store.getPurchase(id);

    if (p.state === "AUTHORIZED") {
      try {
        store.addEvent(id, "delivery_requested", "buyer-agent", { seller: p.agreement.seller.name, endpoint: `/seller/${p.agreement.seller.id}/fulfill` });
        const d = await requestDelivery(SELF, p);
        const path = store.saveArtifact(id, "delivery.csv", d.csv);
        store.addEvent(id, "delivery_received", "seller-agent", { bytes: d.bytes, content_type: d.content_type });
        p = store.updatePurchase(id, { state: "DELIVERED", delivery: { path, bytes: d.bytes, received_at: new Date().toISOString() } });
      } catch (e) { return fail(id, "delivery", e); }
    }

    if (p.state === "DELIVERED") {
      const csv = store.readArtifact(p.delivery.path);
      const v = verifyDelivery(csv, p.agreement);
      store.addEvent(id, "verified", "verification-engine", { delivered: v.delivered, accepted: v.accepted, rejected: v.rejected });
      p = store.updatePurchase(id, { state: "VERIFIED", verification: v });
    }

    if (p.state === "VERIFIED") {
      store.addEvent(id, "ai_started", "ai-analyst", aiInfo());
      const ai = await assess(p.agreement, p.verification);
      store.addEvent(id, "ai_" + ai.status, "ai-analyst", ai.status === "ok" ? { confidence: ai.result.confidence, semantic_match: ai.result.semantic_match } : { error: ai.error, reason: ai.reason });
      p = store.updatePurchase(id, { state: "ASSESSED", ai });
    }

    if (p.state === "ASSESSED") {
      const decision = decide(p.agreement, p.verification, p.ai);
      store.addEvent(id, "decided", "decision-engine", { action: decision.action, capture: centsToStr(decision.capture_cents), review: decision.requires_human_review });
      p = store.updatePurchase(id, { state: decision.requires_human_review ? "AWAITING_REVIEW" : "DECIDED", decision });
    }

    if (p.state === "DECIDED") await settle(id, p.decision.action, "agentkee (autonomous)");
  } finally {
    running.delete(id);
  }
}

// ---------- settlement: the only place money moves ----------
async function settle(id, action, approvedBy) {
  let p = store.getPurchase(id);
  if (!["DECIDED", "AWAITING_REVIEW"].includes(p.state)) throw new Error(`Cannot settle from state ${p.state}`);
  const authId = p.paypal.authorization_id;
  p = store.updatePurchase(id, { state: "SETTLING" });
  store.addEvent(id, "settlement_started", approvedBy, { action });
  try {
    let result;
    if (action === "VOID") {
      const r = await paypal.voidAuthorization(authId, id);
      result = { type: "void", debug_id: r.debug_id };
    } else {
      const full = action === "CAPTURE_FULL";
      const v = p.verification;
      const r = await paypal.captureAuthorization(authId, {
        purchaseId: id,
        amountCents: full ? null : p.decision.capture_cents,
        note: full
          ? `AgentKee: all ${p.agreement.quantity} records verified`
          : `AgentKee: paid for ${v.accepted} of ${p.agreement.quantity} records that passed verification`,
      });
      result = { type: full ? "capture_full" : "capture_partial", capture_id: r.data.id, capture_status: r.data.status, captured: r.data.amount?.value, debug_id: r.debug_id };
    }
    // Source of truth: read the authorization back from PayPal.
    const auth = await paypal.getAuthorization(authId);
    const finalState = action === "VOID" ? "VOIDED" : action === "CAPTURE_FULL" ? "SETTLED_FULL" : "SETTLED_PARTIAL";
    store.addEvent(id, "settled", "paypal", { ...result, authorization_status: auth.status });
    store.updatePurchase(id, {
      state: finalState,
      settled_by: approvedBy,
      paypal: { ...p.paypal, ...result, authorization_status: auth.status, authorization_snapshot: auth, settled_at: new Date().toISOString() },
    });
  } catch (e) {
    fail(id, "settlement", e);
    store.updatePurchase(id, { failure: { ...store.getPurchase(id).failure, resumable_state: p.decision?.requires_human_review ? "AWAITING_REVIEW" : "DECIDED" } });
  }
}

// ---------- API ----------
app.get("/api/status", (_req, res) => {
  res.json({
    paypal: { configured: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET), sandbox: paypal.isSandbox() },
    ai: aiInfo(),
    base_url: PUBLIC_BASE,
  });
});

app.get("/api/sellers", (_req, res) => res.json(Object.values(SELLERS).map(({ file, ...s }) => s)));

app.get("/api/purchases", (_req, res) => {
  res.json(store.listPurchases().map(({ verification, ai, events, ...p }) => ({
    ...p,
    summary: verification ? { delivered: verification.delivered, accepted: verification.accepted } : null,
  })));
});

app.get("/api/purchases/:id", (req, res) => {
  const p = store.getPurchase(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const { authorization_snapshot, ...pp } = p.paypal || {};
  res.json({ ...p, paypal: p.paypal ? { ...pp, links: { order: p.paypal.order_id, capture: p.paypal.capture_id ? sandboxLink("capture", p.paypal.capture_id) : null } } : null });
});

app.get("/api/purchases/:id/delivery.csv", (req, res) => {
  const p = store.getPurchase(req.params.id);
  const csv = p?.delivery?.path && store.readArtifact(p.delivery.path);
  if (!csv) return res.status(404).send("No delivery");
  res.attachment(`${p.id}-delivery.csv`).type("text/csv").send(csv);
});

// Every delivered record with its verdict, for the AG Grid records explorer.
app.get("/api/purchases/:id/records", (req, res) => {
  const p = store.getPurchase(req.params.id);
  const csv = p?.delivery?.path && store.readArtifact(p.delivery.path);
  if (!csv) return res.status(404).json({ error: "No delivery yet" });
  res.json(verifyRecords(csv, p.agreement));
});

app.get("/api/purchases/:id/evidence.json", (req, res) => {
  const p = store.getPurchase(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.attachment(`${p.id}-evidence.json`).json(p);
});

// Create a purchase: buyer agent drafts the agreement, PayPal order (AUTHORIZE) is created.
app.post("/api/purchases", async (req, res) => {
  const b = req.body || {};
  const custom = b.seller_id === "custom";
  const seller = custom ? { id: "custom", name: (b.seller_name || "Your uploaded delivery").slice(0, 60) } : SELLERS[b.seller_id];
  if (!seller) return res.status(400).json({ error: "Unknown seller" });

  const quantity = custom ? parseInt(b.quantity, 10) : seller.quantity;
  const unit = custom ? parseInt(b.unit_price_cents, 10) : seller.unit_price_cents;
  if (!(quantity >= 1 && quantity <= 10000)) return res.status(400).json({ error: "Quantity must be 1–10,000" });
  if (!(unit >= 1 && unit <= 1000)) return res.status(400).json({ error: "Unit price must be 1–1,000 cents" });
  if (quantity * unit > 1_000_000) return res.status(400).json({ error: "Total must be ≤ $10,000 in sandbox" });
  if (custom && !(typeof b.csv === "string" && b.csv.length > 10)) return res.status(400).json({ error: "Upload a CSV delivery file" });

  const agreement = draftAgreement({ seller, quantity, unit_price_cents: unit, review_mode: b.review_mode });
  const p = store.createPurchase({ state: "DRAFT", agreement, paypal: null });
  store.addEvent(p.id, "agreement_drafted", "buyer-agent", { seller: seller.name, quantity, unit_price: centsToStr(unit), total: centsToStr(quantity * unit) });
  if (custom) {
    const path = store.saveArtifact(p.id, "uploaded.csv", b.csv);
    store.updatePurchase(p.id, { custom_delivery_path: path });
  }

  try {
    const { order, approveUrl, debug_id } = await paypal.createAuthorizeOrder({
      purchaseId: p.id,
      amountCents: quantity * unit,
      description: `AgentKee: ${quantity} verified B2B records from ${seller.name}`,
      returnUrl: `${PUBLIC_BASE}/paypal/return?pid=${p.id}`,
      cancelUrl: `${PUBLIC_BASE}/paypal/cancel?pid=${p.id}`,
    });
    store.addEvent(p.id, "paypal_order_created", "paypal", { order_id: order.id, status: order.status, debug_id });
    store.updatePurchase(p.id, { state: "AWAITING_BUYER_APPROVAL", paypal: { order_id: order.id, order_status: order.status, approve_url: approveUrl } });
    res.json({ id: p.id, approve_url: approveUrl });
  } catch (e) {
    fail(p.id, "create_order", e);
    res.status(502).json({ id: p.id, error: e.message, debug_id: e.debug_id || null });
  }
});

// Buyer approved on PayPal -> authorize the order (funds held, not captured).
app.get("/paypal/return", async (req, res) => {
  const { pid, token } = req.query;
  const p = store.getPurchase(pid);
  if (!p) return res.status(404).send("Unknown purchase");
  if (p.paypal?.order_id !== token) return res.status(400).send("Order token mismatch");
  if (p.state === "AWAITING_BUYER_APPROVAL" || (p.state === "FAILED" && p.failure?.step === "authorize")) {
    try {
      const { authorization, debug_id } = await paypal.authorizeOrder(token, pid);
      store.addEvent(pid, "authorized", "paypal", { authorization_id: authorization.id, amount: authorization.amount.value, status: authorization.status, expires: authorization.expiration_time, debug_id });
      store.updatePurchase(pid, {
        state: "AUTHORIZED", failure: null,
        paypal: { ...p.paypal, order_status: "COMPLETED", authorization_id: authorization.id, authorized: authorization.amount.value, authorization_status: authorization.status, authorization_expires: authorization.expiration_time },
      });
      runPipeline(pid).catch((e) => fail(pid, "pipeline", e));
    } catch (e) {
      fail(pid, "authorize", e);
    }
  }
  res.redirect(`/#/p/${pid}`);
});

app.get("/paypal/cancel", (req, res) => {
  const p = store.getPurchase(req.query.pid);
  if (p && p.state === "AWAITING_BUYER_APPROVAL") {
    store.addEvent(p.id, "buyer_cancelled", "buyer", {});
    store.updatePurchase(p.id, { state: "CANCELLED" });
  }
  res.redirect(p ? `/#/p/${p.id}` : "/");
});

// Human review: approve executes the engine's computed decision; reject voids.
// A reviewer can never change the amount.
app.post("/api/purchases/:id/review", async (req, res) => {
  const p = store.getPurchase(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  if (p.state !== "AWAITING_REVIEW") return res.status(409).json({ error: `Purchase is ${p.state}, not awaiting review` });
  const approve = req.body?.decision === "approve";
  store.addEvent(p.id, approve ? "review_approved" : "review_rejected", "human-reviewer", { note: String(req.body?.note || "").slice(0, 300) });
  await settle(p.id, approve ? p.decision.action : "VOID", approve ? "human reviewer (approved)" : "human reviewer (rejected)");
  res.json(store.getPurchase(p.id));
});

// Re-run the AI check (e.g. after a provider timeout) while awaiting review.
app.post("/api/purchases/:id/reassess", async (req, res) => {
  const p = store.getPurchase(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  if (p.state !== "AWAITING_REVIEW") return res.status(409).json({ error: `Purchase is ${p.state}, not awaiting review` });
  store.addEvent(p.id, "retry", "user", { step: "ai" });
  store.updatePurchase(p.id, { state: "VERIFIED", ai: null, decision: null });
  runPipeline(p.id).catch((e) => fail(p.id, "pipeline", e));
  res.json(store.getPurchase(p.id));
});

// Retry a failed step (e.g. network blip to PayPal or the AI provider).
app.post("/api/purchases/:id/retry", async (req, res) => {
  const p = store.getPurchase(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  if (p.state !== "FAILED") return res.status(409).json({ error: "Only failed purchases can be retried" });
  const step = p.failure?.step;
  store.addEvent(p.id, "retry", "user", { step });
  if (step === "delivery") store.updatePurchase(p.id, { state: "AUTHORIZED" });
  else if (step === "settlement") store.updatePurchase(p.id, { state: p.failure.resumable_state || "DECIDED" });
  else if (step === "authorize") return res.status(409).json({ error: "Re-open the PayPal approval link to retry authorization", approve_url: p.paypal?.approve_url });
  else return res.status(409).json({ error: `Step "${step}" cannot be retried; start a new purchase` });
  const cur = store.getPurchase(p.id);
  if (cur.state === "AWAITING_REVIEW") return res.json(cur);
  runPipeline(p.id).catch((e) => fail(p.id, "pipeline", e));
  res.json(store.getPurchase(p.id));
});

// Re-read live status from PayPal (proves the dashboard isn't inventing it).
app.post("/api/purchases/:id/refresh", async (req, res) => {
  const p = store.getPurchase(req.params.id);
  if (!p?.paypal?.authorization_id) return res.status(409).json({ error: "No PayPal authorization yet" });
  try {
    const auth = await paypal.getAuthorization(p.paypal.authorization_id);
    store.addEvent(p.id, "paypal_refreshed", "paypal", { authorization_status: auth.status });
    store.updatePurchase(p.id, { paypal: { ...p.paypal, authorization_status: auth.status, authorization_snapshot: auth, refreshed_at: new Date().toISOString() } });
    res.json({ authorization_status: auth.status, authorization: auth });
  } catch (e) {
    res.status(502).json(errInfo(e));
  }
});

app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

// Resume any purchase interrupted by a restart. Settlement is idempotent at
// PayPal (PayPal-Request-Id), so resuming can never capture twice.
for (const p of store.listPurchases()) {
  if (p.state === "SETTLING") fail(p.id, "settlement", new Error("Server restarted during settlement — retry is safe (idempotent)"));
  if (p.state === "SETTLING") store.updatePurchase(p.id, { failure: { ...store.getPurchase(p.id).failure, resumable_state: p.decision?.requires_human_review ? "AWAITING_REVIEW" : "DECIDED" } });
  if (["AUTHORIZED", "DELIVERED", "VERIFIED", "ASSESSED", "DECIDED"].includes(p.state)) runPipeline(p.id).catch((e) => fail(p.id, "pipeline", e));
}

app.listen(PORT, () => {
  console.log(`AgentKee running at ${PUBLIC_BASE}  (PayPal ${paypal.isSandbox() ? "SANDBOX" : "LIVE"}, AI: ${aiInfo().configured ? aiInfo().provider : "not configured"})`);
});
