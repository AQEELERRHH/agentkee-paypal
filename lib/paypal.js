// PayPal REST client (Orders v2 + Payments v2). Sandbox by default.
// Every call returns PayPal's real response; failures throw a PayPalError
// carrying the HTTP status, PayPal's error name/message and debug_id.
import { randomUUID } from "node:crypto";
import { centsToStr } from "./env.js";

const API = () => process.env.PAYPAL_API || "https://api-m.sandbox.paypal.com";
export const isSandbox = () => API().includes("sandbox");

export class PayPalError extends Error {
  constructor(status, body, path) {
    const name = body?.name || body?.error || "PAYPAL_ERROR";
    const msg =
      body?.details?.[0]?.description || body?.message || body?.error_description || JSON.stringify(body);
    super(`PayPal ${status} ${name}: ${msg}`);
    this.status = status;
    this.body = body;
    this.path = path;
    this.debug_id = body?.debug_id || null;
  }
}

let cached = { token: null, exp: 0 };

async function net(url, opts) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`Couldn't reach PayPal at ${new URL(url).host}: ${e.cause?.code || e.cause?.message || e.message}`);
  }
}

async function token() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
  const r = await net(`${API()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PayPalError(r.status, j, "/v1/oauth2/token");
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

// requestId makes payment actions idempotent: retrying the same action with the
// same id can never capture twice.
async function call(method, path, body, requestId) {
  const r = await net(`${API()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "PayPal-Request-Id": requestId || randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new PayPalError(r.status, j, path);
  return { data: j, debug_id: r.headers.get("paypal-debug-id") };
}

export async function createAuthorizeOrder({ purchaseId, amountCents, description, returnUrl, cancelUrl }) {
  const { data, debug_id } = await call(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [{
        reference_id: purchaseId,
        custom_id: purchaseId,
        description: description.slice(0, 127),
        amount: { currency_code: "USD", value: centsToStr(amountCents) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "AgentKee",
            user_action: "CONTINUE",
            shipping_preference: "NO_SHIPPING",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    },
    `order-${purchaseId}`
  );
  const approve = data.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  return { order: data, approveUrl: approve?.href, debug_id };
}

export async function getOrder(orderId) {
  return (await call("GET", `/v2/checkout/orders/${orderId}`)).data;
}

export async function authorizeOrder(orderId, purchaseId) {
  const { data, debug_id } = await call("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${purchaseId}`);
  const auth = data.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error("PayPal returned no authorization on the order");
  return { order: data, authorization: auth, debug_id };
}

export async function captureAuthorization(authId, { amountCents, note, purchaseId }) {
  const body = { final_capture: true, note_to_payer: note?.slice(0, 255) };
  if (amountCents != null) body.amount = { currency_code: "USD", value: centsToStr(amountCents) };
  return call("POST", `/v2/payments/authorizations/${authId}/capture`, body, `capture-${purchaseId}`);
}

export async function voidAuthorization(authId, purchaseId) {
  return call("POST", `/v2/payments/authorizations/${authId}/void`, null, `void-${purchaseId}`);
}

export async function getAuthorization(authId) {
  return (await call("GET", `/v2/payments/authorizations/${authId}`)).data;
}

export async function getCapture(captureId) {
  return (await call("GET", `/v2/payments/captures/${captureId}`)).data;
}
