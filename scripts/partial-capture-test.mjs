// AgentKee — PayPal sandbox partial-capture test
// Proves: authorize $10.00 -> capture $7.20 (final_capture) -> remaining $2.80 released.
// Run:  node scripts/partial-capture-test.mjs   (from the project folder)
// Needs Node 18+ and a .env file in the same folder with:
//   PAYPAL_CLIENT_ID=...
//   PAYPAL_CLIENT_SECRET=...

import { readFileSync, existsSync } from "node:fs";
import readline from "node:readline/promises";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const API = process.env.PAYPAL_API || "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET } = process.env;
if (!ID || !SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}

async function token() {
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Token failed: " + JSON.stringify(j));
  return j.access_token;
}

async function call(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}\n${JSON.stringify(j, null, 2)}`);
  return j;
}

const step = (n, s) => console.log(`\n[${n}] ${s}`);

try {
  const tok = await token();
  step(1, "Got sandbox access token ✔");

  const order = await call(tok, "POST", "/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [{
      reference_id: "agentkee-test",
      description: "AgentKee test: 1,000 verified records @ $0.01",
      amount: { currency_code: "USD", value: "10.00" },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          user_action: "CONTINUE",
          return_url: "https://example.com/approved",
          cancel_url: "https://example.com/cancelled",
        },
      },
    },
  });
  const approve = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  step(2, `Order created: ${order.id} (status ${order.status})`);
  console.log("\n  Open this link, log in with your SANDBOX PERSONAL account, and approve:\n");
  console.log("  " + approve.href + "\n");
  console.log("  (After approving you'll land on example.com — that's expected. Come back here.)");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\n  Press Enter after you've approved... ");
  rl.close();

  const authOrder = await call(tok, "POST", `/v2/checkout/orders/${order.id}/authorize`, {});
  const auth = authOrder.purchase_units[0].payments.authorizations[0];
  step(3, `Authorized $${auth.amount.value} — authorization ${auth.id} (status ${auth.status}) ✔`);

  const cap = await call(tok, "POST", `/v2/payments/authorizations/${auth.id}/capture`, {
    amount: { currency_code: "USD", value: "7.20" },
    final_capture: true,
    note_to_payer: "AgentKee: paid for 720 of 1,000 records that passed verification",
  });
  step(4, `Captured $${cap.amount.value} — capture ${cap.id} (status ${cap.status}) ✔`);

  const after = await call(tok, "GET", `/v2/payments/authorizations/${auth.id}`);
  step(5, `Authorization now: status ${after.status}`);
  console.log(`\n  RESULT: authorized $10.00, captured $${cap.amount.value}, authorization status = ${after.status}`);
  console.log("  If status is CAPTURED (or PARTIALLY_CAPTURED with final capture), the $2.80 remainder was released. ✅");
} catch (e) {
  console.error("\n❌ TEST FAILED\n" + e.message);
  process.exit(1);
}
