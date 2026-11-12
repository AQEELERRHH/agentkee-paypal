// AI semantic assessment. Provider-agnostic: OpenAI, Groq, Gemini (OpenAI-
// compatible endpoints) or Anthropic. The AI only judges what code cannot —
// whether accepted records genuinely fit the agreed purpose — and explains the
// outcome. It never sets amounts. If not configured or failing, we say so.

const PROVIDERS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.8-flash" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-5" },
};

export function aiInfo() {
  const provider = (process.env.AI_PROVIDER || "").toLowerCase();
  const p = PROVIDERS[provider];
  if (!p || !process.env.AI_API_KEY) return { configured: false, provider: provider || null };
  return { configured: true, provider, model: process.env.AI_MODEL || p.model };
}

function prompt(agreement, verification) {
  return `You are AgentKee's verification analyst. A buyer AI agent paid (held, not yet captured) for a data delivery.
Deterministic code has ALREADY checked format rules and counted accepted records. Do NOT recount or change any numbers.

Your job:
1. Judge whether the ACCEPTED sample records genuinely fit the agreed purpose (semantic fit) — e.g. are these plausibly ${agreement.criteria.purpose}?
2. Note any concerns code cannot detect (e.g. obviously fabricated-looking patterns, wrong industry, roles that don't match).
3. Write a short plain-English explanation of the verification outcome for the buyer.

AGREEMENT:
${JSON.stringify({ product: agreement.product, quantity: agreement.quantity, purpose: agreement.criteria.purpose, allowed_countries: agreement.criteria.allowed_countries }, null, 2)}

CODE VERIFICATION RESULT (authoritative):
${JSON.stringify({ delivered: verification.delivered, accepted: verification.accepted, rejected: verification.rejected, rule_failures: verification.rule_failures, findings: verification.findings }, null, 2)}

ACCEPTED SAMPLE (${Math.min(15, verification.accepted_sample.length)} records):
${JSON.stringify(verification.accepted_sample.slice(0, 15))}

Respond with ONLY a JSON object:
{"semantic_match": true|false, "confidence": 0.0-1.0, "concerns": ["..."], "summary": "2-3 sentences for the buyer"}`;
}

function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI response contained no JSON");
  const j = JSON.parse(m[0]);
  if (typeof j.semantic_match !== "boolean" || typeof j.confidence !== "number")
    throw new Error("AI response missing semantic_match/confidence");
  j.confidence = Math.max(0, Math.min(1, j.confidence));
  j.concerns = Array.isArray(j.concerns) ? j.concerns.map(String).slice(0, 8) : [];
  j.summary = String(j.summary || "");
  return j;
}

export async function assess(agreement, verification) {
  const info = aiInfo();
  if (!info.configured) return { status: "not_configured", provider: info.provider };
  if (verification.accepted === 0)
    return { status: "skipped", provider: info.provider, model: info.model, reason: "No accepted records to assess" };

  const p = PROVIDERS[info.provider];
  const started = Date.now();
  const content = prompt(agreement, verification);
  const perTry = Number(process.env.AI_TIMEOUT_MS || 35_000);
  // If a model is overloaded (503/429) or silent, fall back to the next one.
  const models = [...new Set([info.model, ...(FALLBACKS[info.provider] || [])])];
  const attempts = [];

  for (const model of models) {
    const t = Date.now();
    try {
      const text = await callModel(info.provider, p.url, model, content, AbortSignal.timeout(perTry));
      attempts.push({ model, ok: true, ms: Date.now() - t });
      return { status: "ok", provider: info.provider, model, duration_ms: Date.now() - started, attempts, result: extractJSON(text) };
    } catch (e) {
      const msg = e.name === "TimeoutError" || /aborted/i.test(e.message) ? `no answer within ${perTry / 1000}s` : e.message;
      attempts.push({ model, ok: false, ms: Date.now() - t, error: msg.slice(0, 200) });
      if (!e.retryable && !/no answer|AI response/.test(msg)) break; // e.g. bad key: don't hammer other models
    }
  }
  return {
    status: "error", provider: info.provider, model: models.join(", "), duration_ms: Date.now() - started, attempts,
    error: attempts.map((a) => `${a.model}: ${a.error}`).join(" · "),
  };
}

const FALLBACKS = {
  gemini: ["gemini-3.8-flash", "gemini-flash-latest", "gemini-flash-lite-latest"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  openai: ["gpt-4o-mini"],
  anthropic: [],
};

async function callModel(provider, url, model, content, signal) {
  let r, j;
  if (provider === "anthropic") {
    r = await fetch(url, {
      method: "POST", signal,
      headers: { "x-api-key": process.env.AI_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 800, messages: [{ role: "user", content }] }),
    });
  } else {
    r = await fetch(url, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        // Keep "thinking" models fast: this is a short judgement, not a puzzle.
        ...(provider === "gemini" ? { reasoning_effort: process.env.AI_REASONING || "low" } : {}),
        messages: [{ role: "user", content }],
      }),
    });
  }
  const raw = await r.text();
  try { j = JSON.parse(raw); } catch { j = { raw }; }
  if (!r.ok) {
    const err = new Error(`${r.status} ${(Array.isArray(j) ? j[0] : j)?.error?.message || raw.slice(0, 200)}`);
    err.retryable = [404, 408, 429, 500, 502, 503, 504].includes(r.status);
    throw err;
  }
  return provider === "anthropic" ? j.content?.map((b) => b.text || "").join("") : j.choices?.[0]?.message?.content || "";
}
