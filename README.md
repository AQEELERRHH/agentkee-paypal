# AgentKee 

<img width="1899" height="748" alt="image" src="https://github.com/user-attachments/assets/06cb6498-0c63-4ddc-b59a-1a4ee6f6dbc8" />


**AI agents should pay for what was delivered, not just what was promised.** 

<img width="1919" height="764" alt="image" src="https://github.com/user-attachments/assets/4954faa7-bb4d-499a-b437-4dd356191d06" />

<img width="1399" height="813" alt="image" src="https://github.com/user-attachments/assets/c100843c-f554-4632-8b02-76815de7d7af" />


AgentKee is a payment-control layer for autonomous AI purchases on PayPal. When an AI buyer agent buys a digital deliverable (in this demo, a list of B2B contact records), PayPal **holds** the payment. AgentKee checks the delivery against the agreement, then pays the seller for **exactly the records that passed** and releases the rest back to the buyer.

| Delivery | What AgentKee does on PayPal |
|---|---|
| 1,000 of 1,000 records pass | **Capture** the full $10.00 |
| 720 of 1,000 records pass | **Partial capture** of $7.20 (`final_capture: true`); PayPal releases the remaining $2.80 |
| 0 records pass, or fewer than the agreed minimum | **Void** the authorization; the buyer is never charged |

Everything runs against the real **PayPal sandbox**: real orders, real authorizations, real captures and voids. After every action, AgentKee reads the authorization back from PayPal and shows PayPal's status, so the dashboard never invents a payment outcome.

---

## Why this matters

AI agents are starting to spend money on our behalf: buying data, API calls, generated content and freelance work. Today an agent that pays has no built-in way to check it got what it paid for. On crypto agent rails such as x402, settlement is final and there is no chargeback (developers have reported agents paying and receiving nothing, with no refund path). AgentKee started as a chargeback layer for x402. This version brings the idea to PayPal, which already has the right primitive: **authorize now, capture later, capture less, or void**.

## How it works

```
Buyer agent ──drafts agreement──▶ PayPal order (intent: AUTHORIZE) ──buyer approves──▶ funds HELD
     │
     └──HTTP──▶ Seller agent (/seller/:id/fulfill) ──returns CSV delivery
                         │
                         ▼
        Verification engine (code)   checks every record against measurable rules
                         ▼
        AI analyst (LLM)             judges semantic fit, explains, can only ESCALATE
                         ▼
        Decision engine (code)       payable = verified records × unit price
                         ▼
        PayPal  capture  |  partial capture (final_capture)  |  void
                         ▼
        GET authorization ▶ PayPal's own status stored as the source of truth
```

### Design rules

1. **Code calculates money; AI never does.** The accepted count and payable amount come only from deterministic verification. The AI judges what code can't (do these records actually fit "senior people at fintech companies"?) and writes the explanation. Its only power is to send a decision to a human.
2. **Every rejection is explained.** Each rejected record names the rule it broke and why.
3. **Humans stay in control.** The buyer can require approval for every payment. Any AI concern, low confidence (< 0.60) or AI outage also routes paying actions to human review. A reviewer can approve or reject but **cannot change the amount**.
4. **PayPal is the source of truth.** Status shown in the UI is read back from PayPal (`GET /v2/payments/authorizations/{id}`), and there's a "Re-check with PayPal" button on every purchase.
5. **No double charges.** Every payment action sends a deterministic `PayPal-Request-Id`, so retries are idempotent. Purchases interrupted by a restart resume safely.
6. **Real failures, shown honestly.** PayPal, AI and seller errors are stored with PayPal `debug_id`s, displayed, and retryable where safe.

### Acceptance rules (per record)

All 8 agreed columns present and non-empty · valid, non-disposable email · email domain matches the company website · phone in E.164 international format · country in the agreed markets · valid https website · no duplicates · at least 50% of promised records must pass, or the whole delivery is rejected.

## PayPal APIs used

| Step | Endpoint |
|---|---|
| Hold the payment | `POST /v2/checkout/orders` with `intent: AUTHORIZE` → buyer approval → `POST /v2/checkout/orders/{id}/authorize` |
| Pay in full | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: true`) |
| Pay for verified records only | `POST /v2/payments/authorizations/{id}/capture` with a smaller `amount` and `final_capture: true` |
| Reject the delivery | `POST /v2/payments/authorizations/{id}/void` |
| Confirm with PayPal | `GET /v2/payments/authorizations/{id}` |

## AI

Provider-agnostic: set `AI_PROVIDER` to `openai`, `groq`, `gemini` or `anthropic` and add `AI_API_KEY`. With no key, AgentKee still verifies and computes the payment, but asks a human before paying anything.

---

## Run it locally

Requires **Node.js 18+**.

```bash
git clone https://github.com/AQEELERRHH/agentkee-paypal.git
cd agentkee-paypal
npm install
cp .env.example .env        # Windows PowerShell: copy .env.example .env
# fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and optionally AI_PROVIDER / AI_API_KEY
npm start
```

Open http://localhost:3000.

### PayPal sandbox setup

1. At [developer.paypal.com](https://developer.paypal.com/dashboard/), with the **Sandbox** toggle on, go to **Testing Tools → Sandbox Accounts** and create a **Business** account in a country that can receive payments (for example **United States**).
2. Go to **Apps & Credentials → Create App** (type Merchant), linked to that Business account. Copy the Client ID and Secret into `.env`.
3. Use any sandbox **Personal** account to approve payments in the PayPal popup.

### Try the three scenarios

1. **New purchase → Ledgerline Data → Hold $10.00 with PayPal**, approve with the sandbox buyer. Result: paid $10.00 in full.
2. **LeadSprint**: 720 records pass. Result: $7.20 captured, $2.80 released.
3. **BulkReach**: nothing passes. Result: authorization voided.
4. **Upload your own delivery**: act as the seller with any CSV and see how AgentKee judges it.

Tick **"Ask me before paying"** to approve each settlement yourself.

### Tests

```bash
npm test
```

Checks the verification and decision engines against the real demo files (1000/1000 → full, 720/1000 → $7.20, 0/1000 → void, minimum-ratio void, AI-can't-change-amount, schema breach, over-delivery). `scripts/partial-capture-test.mjs` is a standalone script that proves partial capture on your own sandbox account.

## Deploy on Render

The repo includes `render.yaml`. In Render choose **New → Blueprint**, select this repo, and set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `AI_PROVIDER` and `AI_API_KEY`. The PayPal return URL uses Render's public URL automatically. On the free plan, stored purchases reset when the service redeploys.

## Project layout

```
server.js            API, pipeline and settlement
lib/paypal.js        PayPal Orders v2 / Payments v2 client (idempotent actions)
lib/verify.js        deterministic verification engine
lib/decide.js        deterministic payment decision + escalation rules
lib/ai.js            AI semantic check (OpenAI / Groq / Gemini / Anthropic)
lib/agents.js        buyer agent, agreement, seller agent HTTP services
lib/store.js         durable JSON store with full event log
datasets/            demo seller deliveries (synthetic data, generated by scripts/make-datasets.mjs)
public/              dashboard (vanilla JS, no build step)
```

## Roadmap

- PayPal **Disputes API**: when a problem surfaces after capture, open a dispute with AgentKee's evidence report attached
- PayPal **Vault** so an agent can pay within a pre-approved budget without a popup per purchase
- Verification packs beyond contact data: API response SLAs, generated documents, translation quality, dataset schemas
- Webhooks for authorization expiry and capture reversal

## License

MIT. All people and companies in the demo datasets are synthetic.
