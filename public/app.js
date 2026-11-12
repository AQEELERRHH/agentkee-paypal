// AgentKee dashboard. Everything shown here is read from the backend, which is
// the source of truth; the UI never invents payment status.
const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (cents) => "$" + (cents / 100).toFixed(2);
const time = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || j.message || `Request failed (${r.status})`), { body: j });
  return j;
}

const STATES = {
  DRAFT: ["Drafting agreement", "s-work"],
  AWAITING_BUYER_APPROVAL: ["Waiting for PayPal approval", "s-work"],
  AUTHORIZED: ["Payment held · requesting delivery", "s-work pulse"],
  DELIVERED: ["Delivery received · verifying", "s-work pulse"],
  VERIFIED: ["Verified · AI reviewing", "s-work pulse"],
  ASSESSED: ["Deciding payment", "s-work pulse"],
  DECIDED: ["Decision made · settling", "s-work pulse"],
  AWAITING_REVIEW: ["Needs your approval", "s-review"],
  SETTLING: ["Settling with PayPal", "s-work pulse"],
  SETTLED_FULL: ["Paid in full", "s-paid"],
  SETTLED_PARTIAL: ["Paid for verified records", "s-partial"],
  VOIDED: ["Rejected · hold released", "s-void"],
  CANCELLED: ["Cancelled by buyer", ""],
  FAILED: ["Failed", "s-fail"],
};
const TERMINAL = new Set(["SETTLED_FULL", "SETTLED_PARTIAL", "VOIDED", "CANCELLED", "FAILED", "AWAITING_REVIEW", "AWAITING_BUYER_APPROVAL"]);
const pill = (s) => { const [l, c] = STATES[s] || [s, ""]; return `<span class="state ${c}">${esc(l)}</span>`; };

function split(p) {
  const a = p.agreement.quantity * p.agreement.unit_price_cents;
  if (p.state === "SETTLED_FULL" || p.state === "SETTLED_PARTIAL") {
    const paid = p.decision.capture_cents;
    return { a, paid, released: a - paid, pending: 0 };
  }
  if (p.state === "VOIDED") return { a, paid: 0, released: a, pending: 0 };
  const held = p.paypal?.authorization_id && !["CANCELLED"].includes(p.state);
  return { a, paid: 0, released: 0, pending: held ? a : 0 };
}
function bar(s, big = false) {
  const seg = (k) => `<i class="${k}" style="flex-grow:${s[k]}"></i>`;
  const label = `${usd(s.paid)} paid, ${usd(s.released)} released, ${usd(s.pending)} held of ${usd(s.a)}`;
  return `<div class="bar${big ? " big" : ""}" role="img" aria-label="${label}">${s.paid ? seg("paid") : ""}${s.pending ? seg("pending") : ""}${s.released ? seg("released") : ""}</div>`;
}

let env = null;
async function loadEnv() {
  try {
    env = await api("/api/status");
    document.getElementById("env").textContent =
      `${env.paypal.sandbox ? "PayPal sandbox" : "PayPal LIVE"} · AI: ${env.ai.configured ? env.ai.provider : "off"}`;
  } catch { document.getElementById("env").textContent = "Server unreachable"; }
}

// ---------------- Dashboard ----------------
async function viewList() {
  const list = await api("/api/purchases");
  const t = list.reduce((acc, p) => { const s = split(p); acc.paid += s.paid; acc.released += s.released; acc.held += s.pending; return acc; }, { paid: 0, released: 0, held: 0 });
  $app.innerHTML = `
    <section class="hero">
      <div>
        <h1>Agents should pay for what was delivered.</h1>
        <p>AgentKee holds an AI agent's PayPal payment, checks the delivery against the agreement, then pays the seller for exactly what passed. The rest goes back to the buyer.</p>
        <a class="btn" href="#/new">Start a purchase</a>
      </div>
      <div class="totals" aria-label="Totals across all purchases">
        <div class="total paid"><span>Paid to sellers</span><b>${usd(t.paid)}</b></div>
        <div class="total released"><span>Released to buyers</span><b>${usd(t.released)}</b></div>
        <div class="total held"><span>Held, awaiting verification</span><b>${usd(t.held)}</b></div>
      </div>
    </section>
    <div class="list-head"><h2>Purchases</h2><span class="notice">${list.length} total</span></div>
    ${list.length ? `<div class="rows">${list.map((p) => {
      const s = split(p);
      return `<a class="row" href="#/p/${p.id}">
        <div class="who"><b>${esc(p.agreement.seller.name)}</b><span>${p.agreement.quantity.toLocaleString()} records · ${usd(p.agreement.unit_price_cents)} each</span></div>
        <div>${pill(p.state)}</div>
        ${bar(s)}
        <div class="amt">${usd(s.paid)}<span>of ${usd(s.a)}</span></div>
      </a>`;
    }).join("")}</div>` : `<div class="empty">No purchases yet. Start one to watch a payment get held, verified and settled.<br><a class="btn" href="#/new">Start a purchase</a></div>`}`;
}

// ---------------- New purchase ----------------
async function viewNew() {
  const sellers = await api("/api/sellers");
  let chosen = sellers[0].id, csv = null, fileName = "";
  const render = () => {
    const custom = chosen === "custom";
    const s = sellers.find((x) => x.id === chosen);
    $app.innerHTML = `
      <h1 class="page-title">New purchase</h1>
      <p class="lede">Your buyer agent wants 1,000 contacts of senior people at fintech and payments companies. Pick who sells them. The sellers below are sandbox test sellers with real delivery files, or you can act as the seller and upload your own file.</p>
      <div class="sellers" role="group" aria-label="Choose a seller">
        ${sellers.map((x) => `<button class="seller" data-id="${x.id}" aria-pressed="${x.id === chosen}"><b>${esc(x.name)}</b><span>${esc(x.tagline)}</span><div class="price">${x.quantity.toLocaleString()} records · ${usd(x.unit_price_cents)} each</div></button>`).join("")}
        <button class="seller" data-id="custom" aria-pressed="${custom}"><b>Upload your own delivery</b><span>Act as the seller: upload any CSV and see how AgentKee judges it</span><div class="price">You set quantity and price</div></button>
      </div>
      <div class="layout-2">
        <div class="panel">
          <h3>The agreement your agent will sign</h3>
          ${custom ? `
            <label class="field">Seller name<input id="sname" value="My data shop" maxlength="60"></label>
            <label class="field">Records promised<input id="qty" type="number" min="1" max="10000" value="100"></label>
            <label class="field">Price per record (cents)<input id="unit" type="number" min="1" max="1000" value="5"></label>
            <label class="field">Delivery file (.csv)<input id="file" type="file" accept=".csv,text/csv"></label>
            <p class="drop">Columns must be: id, company, contact_name, title, email, phone, country, website. ${fileName ? `Loaded <b>${esc(fileName)}</b>.` : ""} <a href="/datasets/leadsprint.csv" download>Download a sample</a></p>` : `
            <dl class="kv">
              <dt>Seller</dt><dd>${esc(s.name)}</dd>
              <dt>Records</dt><dd>${s.quantity.toLocaleString()}</dd>
              <dt>Price</dt><dd>${usd(s.unit_price_cents)} per verified record</dd>
              <dt>Held on PayPal</dt><dd><b>${usd(s.quantity * s.unit_price_cents)}</b></dd>
            </dl>`}
          <h3 style="margin-top:22px">What every record must pass</h3>
          <dl class="kv">
            <dt>Format</dt><dd>All 8 agreed columns, no empty fields</dd>
            <dt>Email</dt><dd>Valid, not disposable, same domain as the company website</dd>
            <dt>Phone</dt><dd>International format (+234…, +1…)</dd>
            <dt>Markets</dt><dd>US, GB, CA, NG, KE, ZA, GH</dd>
            <dt>Duplicates</dt><dd>Not allowed</dd>
            <dt>Minimum</dt><dd>At least 50% must pass, or the delivery is rejected</dd>
          </dl>
        </div>
        <div class="panel">
          <h3>Payment</h3>
          <p class="notice">PayPal holds the full amount. Nothing reaches the seller until AgentKee has checked the delivery.</p>
          <label class="check"><input type="checkbox" id="review"> <span>Ask me before paying<small>Otherwise AgentKee settles on its own when checks and AI agree.</small></span></label>
          <button class="btn btn-paypal" id="go">Hold ${custom ? "payment" : usd(s.quantity * s.unit_price_cents)} with PayPal</button>
          <div id="err"></div>
        </div>
      </div>`;
    $app.querySelectorAll(".seller").forEach((b) => b.addEventListener("click", () => { chosen = b.dataset.id; render(); }));
    const f = document.getElementById("file");
    if (f) f.addEventListener("change", async () => {
      const file = f.files[0];
      if (!file) return;
      if (file.size > 2_500_000) { document.getElementById("err").innerHTML = `<div class="error">File is larger than 2.5 MB.</div>`; return; }
      csv = await file.text(); fileName = file.name;
      document.querySelector(".drop").innerHTML = `Loaded <b>${esc(fileName)}</b> (${csv.split(/\r?\n/).filter(Boolean).length - 1} rows).`;
    });
    document.getElementById("go").addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Creating PayPal order…";
      const body = { seller_id: chosen, review_mode: document.getElementById("review").checked ? "always" : "auto" };
      if (custom) Object.assign(body, { seller_name: document.getElementById("sname").value, quantity: document.getElementById("qty").value, unit_price_cents: document.getElementById("unit").value, csv });
      try {
        const r = await api("/api/purchases", { method: "POST", body: JSON.stringify(body) });
        btn.textContent = "Opening PayPal…";
        location.href = r.approve_url;
      } catch (err) {
        btn.disabled = false; btn.textContent = "Try again";
        document.getElementById("err").innerHTML = `<div class="error"><b>Couldn't create the PayPal order.</b><br>${esc(err.message)}${err.body?.debug_id ? `<br>PayPal debug id: <code>${esc(err.body.debug_id)}</code>` : ""}</div>`;
      }
    });
  };
  render();
}

// ---------------- Purchase detail ----------------
const EVENT_LABELS = {
  agreement_drafted: "Buyer agent drafted the agreement",
  paypal_order_created: "PayPal order created (intent: authorize)",
  authorized: "Buyer approved · PayPal is holding the payment",
  delivery_requested: "Buyer agent requested delivery from seller",
  delivery_received: "Seller agent delivered the file",
  verified: "Verification engine checked every record",
  ai_started: "AI analyst reviewing accepted records",
  ai_ok: "AI analysis complete",
  ai_not_configured: "AI analysis not configured",
  ai_skipped: "AI analysis skipped",
  ai_error: "AI analysis failed",
  decided: "Decision engine computed the payment",
  review_approved: "Human reviewer approved",
  review_rejected: "Human reviewer rejected",
  settlement_started: "Settlement sent to PayPal",
  settled: "PayPal confirmed settlement",
  paypal_refreshed: "Status re-read from PayPal",
  buyer_cancelled: "Buyer cancelled on PayPal",
  retry: "Retry requested",
  error: "Error",
};
function eventDetail(e) {
  const d = e.detail || {};
  switch (e.type) {
    case "agreement_drafted": return `${d.quantity} records × $${d.unit_price} = $${d.total}`;
    case "paypal_order_created": return `Order ${d.order_id}`;
    case "authorized": return `Authorization ${d.authorization_id} · $${d.amount}`;
    case "delivery_received": return `${(d.bytes / 1024).toFixed(1)} KB received`;
    case "verified": return `${d.accepted} accepted · ${d.rejected} rejected of ${d.delivered}`;
    case "ai_started": return d.configured ? `${d.provider} · ${d.model}` : "No AI key set";
    case "ai_ok": return `Confidence ${d.confidence?.toFixed?.(2)} · ${d.semantic_match ? "matches purpose" : "does not match purpose"}`;
    case "ai_error": return d.error;
    case "decided": return `${d.action.replace("_", " ").toLowerCase()} · $${d.capture}${d.review ? " · needs approval" : ""}`;
    case "settled": return `${d.capture_id ? `Capture ${d.capture_id} · ` : ""}authorization ${d.authorization_status}`;
    case "paypal_refreshed": return `Authorization ${d.authorization_status}`;
    case "error": return `${d.step}: ${d.message}`;
    default: return d.action || d.seller || d.note || "";
  }
}

const STEP_NAMES = { create_order: "PayPal order", authorize: "PayPal authorization", delivery: "seller delivery", settlement: "PayPal settlement", pipeline: "processing" };
const RETRYABLE = new Set(["delivery", "settlement"]);
let pollTimer = null;
async function viewDetail(id) {
  let p;
  try { p = await api(`/api/purchases/${id}`); }
  catch (e) { $app.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const s = split(p), a = p.agreement, v = p.verification, ai = p.ai, d = p.decision, pp = p.paypal || {};

  $app.innerHTML = `
    <div class="detail-head">
      <div><div class="sub">Purchase <code>${esc(p.id)}</code> · ${time(p.created_at)}</div>
      <h1>${a.quantity.toLocaleString()} records from ${esc(a.seller.name)}</h1></div>
      ${pill(p.state)}
    </div>

    <section class="settle" aria-label="Settlement">
      ${bar(s, true)}
      <div class="legend">
        <div class="paid"><b>${usd(s.paid)}</b><span>Paid to seller</span></div>
        <div class="released"><b>${usd(s.released)}</b><span>Released to buyer</span></div>
        ${s.pending ? `<div class="pending"><b>${usd(s.pending)}</b><span>Held by PayPal</span></div>` : ""}
      </div>
      ${d ? `<div class="math">${esc(d.math)}. ${esc(d.reason)}</div>` : ""}
    </section>

    ${p.state === "AWAITING_REVIEW" ? `
      <div class="panel review">
        <h3>Your approval is needed</h3>
        <p>AgentKee computed: <b>${esc(d.math)}</b>.</p>
        <ul class="concerns">${d.escalations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <div class="actions">
          <button class="btn" data-review="approve">${d.action === "VOID" ? "Confirm rejection" : `Approve: pay ${usd(d.capture_cents)}`}</button>
          ${d.action === "VOID" ? "" : `<button class="btn btn-ghost" data-review="reject">Reject delivery, release ${usd(d.authorized_cents)}</button>`}
          ${ai && ai.status === "error" ? `<button class="btn btn-ghost" id="reassess">Run AI check again</button>` : ""}
        </div>
        <p class="notice">You can approve or reject, but not change the amount: it comes from verified records only.</p>
      </div>` : ""}

    ${p.state === "AWAITING_BUYER_APPROVAL" ? `<div class="panel"><h3>Waiting for you on PayPal</h3><p class="notice">The order exists but the payment isn't held yet.</p><a class="btn btn-paypal" href="${esc(pp.approve_url)}">Continue to PayPal</a></div>` : ""}

    ${p.state === "FAILED" ? `
      <div class="panel" style="border-color:#6b2f33">
        <h3>The ${esc(STEP_NAMES[p.failure.step] || p.failure.step)} step failed</h3>
        <div class="error">${esc(p.failure.message)}${p.failure.debug_id ? `<br>PayPal debug id: <code>${esc(p.failure.debug_id)}</code>` : ""}</div>
        <div class="actions-row">${RETRYABLE.has(p.failure.step)
          ? `<button class="btn" id="retry">Retry ${esc(STEP_NAMES[p.failure.step])}</button><span class="notice">Safe to retry: PayPal won't charge twice.</span>`
          : p.failure.step === "authorize" && p.paypal?.approve_url ? `<a class="btn btn-paypal" href="${esc(p.paypal.approve_url)}">Approve on PayPal again</a>`
          : `<a class="btn" href="#/new">Start a new purchase</a>`}</div>
        <div id="retry-err"></div>
      </div>` : ""}

    <div class="grid" style="margin-top:28px">
      <aside class="panel">
        <h3>What happened</h3>
        <ol class="timeline">${p.events.map((e) => `<li class="${e.type === "error" || e.type === "ai_error" ? "err" : e.type === "settled" ? "ok" : ""}"><b>${esc(EVENT_LABELS[e.type] || e.type)}</b><span>${esc(eventDetail(e))}</span><br><span>${time(e.ts)} · ${esc(e.actor)}</span></li>`).join("")}</ol>
      </aside>
      <div>
        ${v ? `
        <section class="panel">
          <h3>Verification report</h3>
          <div class="big-num">${v.accepted.toLocaleString()} <span class="notice" style="font-size:16px;font-weight:500">of ${v.promised.toLocaleString()} promised records passed</span></div>
          <p class="notice">${v.delivered.toLocaleString()} delivered · checked by code in ${v.duration_ms} ms · ${esc(v.engine)}</p>
          ${v.findings.map((f) => `<div class="${f.level === "critical" ? "error" : "notice"}">${esc(f.message)}</div>`).join("")}
          <table class="rules"><tbody>
            ${Object.entries(v.rules).map(([k, label]) => `<tr class="${v.rule_failures[k] ? "bad" : "zero"}"><td>${esc(label)}</td><td>${v.rule_failures[k] ? `${v.rule_failures[k]} failed` : "all passed"}</td></tr>`).join("")}
          </tbody></table>
          ${v.rejected_sample.length ? `<details style="margin-top:14px"><summary>See rejected records (first ${v.rejected_sample.length})</summary>
            <ul class="rejects">${v.rejected_sample.map((r) => `<li><b>Row ${r.row}</b> ${r.id ? `<code>${esc(r.id)}</code>` : ""}<br>${r.reasons.map((x) => `<span>${esc(x.detail)}</span>`).join("<br>")}</li>`).join("")}</ul></details>` : ""}
          <div class="actions-row"><a class="btn btn-ghost btn-small" href="/api/purchases/${p.id}/delivery.csv">Download delivered file</a></div>
        </section>` : ""}

        ${ai ? `
        <section class="panel">
          <h3>AI analysis</h3>
          ${ai.status === "ok" ? `
            <p class="ai-sum">${esc(ai.result.summary)}</p>
            <dl class="kv"><dt>Fits the purpose</dt><dd>${ai.result.semantic_match ? "Yes" : "No"}</dd><dt>Confidence</dt><dd>${ai.result.confidence.toFixed(2)}</dd><dt>Model</dt><dd>${esc(ai.provider)} · ${esc(ai.model)} · ${ai.duration_ms} ms</dd>${(ai.attempts || []).filter((x) => !x.ok).length ? `<dt>Fallback</dt><dd>${ai.attempts.filter((x) => !x.ok).map((x) => `${esc(x.model)} unavailable (${esc(x.error)})`).join("; ")}</dd>` : ""}</dl>
            ${ai.result.concerns.length ? `<h3 style="margin-top:16px">Concerns</h3><ul class="concerns">${ai.result.concerns.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}`
          : ai.status === "not_configured" ? `<p class="notice">No AI key is set, so AgentKee won't pay automatically. Add AI_PROVIDER and AI_API_KEY to enable the semantic check.</p>`
          : ai.status === "skipped" ? `<p class="notice">${esc(ai.reason)}. Nothing to pay for, so there's nothing for the AI to judge.</p>`
          : `<div class="error">AI provider error: ${esc(ai.error)}</div><p class="notice">Because the AI check failed, payment needs your approval.</p>`}
          <p class="notice" style="margin-top:12px">The AI can explain and escalate to you. It cannot change how much is paid.</p>
        </section>` : ""}

        <section class="panel">
          <h3>PayPal record</h3>
          <dl class="kv">
            <dt>Order</dt><dd><code>${esc(pp.order_id || "—")}</code></dd>
            <dt>Authorization</dt><dd><code>${esc(pp.authorization_id || "—")}</code>${pp.authorized ? ` · $${esc(pp.authorized)} held` : ""}</dd>
            <dt>Authorization status</dt><dd><b>${esc(pp.authorization_status || "—")}</b>${pp.refreshed_at ? ` <span class="notice">(re-read ${time(pp.refreshed_at)})</span>` : ""}</dd>
            ${pp.capture_id ? `<dt>Capture</dt><dd><code>${esc(pp.capture_id)}</code> · $${esc(pp.captured)} ${esc(pp.capture_status)}</dd>` : ""}
            ${pp.type === "void" ? `<dt>Void</dt><dd>Authorization voided · full hold released</dd>` : ""}
            ${p.settled_by ? `<dt>Settled by</dt><dd>${esc(p.settled_by)}</dd>` : ""}
          </dl>
          <div class="actions-row">
            ${pp.authorization_id ? `<button class="btn btn-ghost btn-small" id="refresh">Re-check with PayPal</button>` : ""}
            <a class="btn btn-ghost btn-small" href="/api/purchases/${p.id}/evidence.json">Download evidence</a>
          </div>
          <div id="refresh-out"></div>
        </section>

        <section class="panel">
          <h3>Agreement</h3>
          <dl class="kv">
            <dt>Seller</dt><dd>${esc(a.seller.name)}</dd>
            <dt>Records</dt><dd>${a.quantity.toLocaleString()} × ${usd(a.unit_price_cents)}</dd>
            <dt>Purpose</dt><dd>${esc(a.criteria.purpose)}</dd>
            <dt>Markets</dt><dd>${esc(a.criteria.allowed_countries.join(", "))}</dd>
            <dt>Minimum passing</dt><dd>${a.criteria.min_acceptance_ratio * 100}%</dd>
            <dt>Approval</dt><dd>${a.review_mode === "always" ? "Human approves every payment" : "Autonomous when checks and AI agree"}</dd>
            <dt>Terms</dt><dd>${esc(a.payment_terms)}</dd>
          </dl>
        </section>
      </div>
    </div>`;

  $app.querySelectorAll("[data-review]").forEach((b) => b.addEventListener("click", async () => {
    $app.querySelectorAll("[data-review]").forEach((x) => (x.disabled = true));
    b.textContent = "Sending to PayPal…";
    try { await api(`/api/purchases/${id}/review`, { method: "POST", body: JSON.stringify({ decision: b.dataset.review }) }); } catch (e) { alertBox(e); }
    viewDetail(id);
  }));
  const reassess = document.getElementById("reassess");
  if (reassess) reassess.addEventListener("click", async () => {
    reassess.disabled = true; reassess.textContent = "Asking the AI…";
    try { await api(`/api/purchases/${id}/reassess`, { method: "POST" }); } catch (e) { alertBox(e); }
    viewDetail(id);
  });
  const retry = document.getElementById("retry");
  if (retry) retry.addEventListener("click", async () => {
    retry.disabled = true;
    try { await api(`/api/purchases/${id}/retry`, { method: "POST" }); viewDetail(id); }
    catch (e) { retry.disabled = false; document.getElementById("retry-err").innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  });
  const refresh = document.getElementById("refresh");
  if (refresh) refresh.addEventListener("click", async () => {
    refresh.disabled = true; refresh.textContent = "Asking PayPal…";
    try { const r = await api(`/api/purchases/${id}/refresh`, { method: "POST" }); await viewDetail(id); document.getElementById("refresh-out").innerHTML = `<p class="notice">PayPal says: authorization <b>${esc(r.authorization_status)}</b>.</p>`; }
    catch (e) { refresh.disabled = false; refresh.textContent = "Re-check with PayPal"; document.getElementById("refresh-out").innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  });

  clearTimeout(pollTimer);
  if (!TERMINAL.has(p.state)) pollTimer = setTimeout(() => location.hash === `#/p/${id}` && viewDetail(id), 1200);
}
function alertBox(e) { $app.insertAdjacentHTML("afterbegin", `<div class="error">${esc(e.message)}</div>`); }

// ---------------- router ----------------
async function route() {
  clearTimeout(pollTimer);
  const h = location.hash || "#/";
  try {
    if (h.startsWith("#/p/")) await viewDetail(h.slice(4));
    else if (h === "#/new") await viewNew();
    else await viewList();
  } catch (e) {
    $app.innerHTML = `<div class="error"><b>Couldn't load this page.</b><br>${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", () => { route(); $app.focus(); });
loadEnv();
route();
