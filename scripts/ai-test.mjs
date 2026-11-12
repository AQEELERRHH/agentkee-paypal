// Diagnoses the AI connection using the same .env as the app.
// Run from the project folder:  node scripts/ai-test.mjs
import { loadEnv } from "../lib/env.js";
loadEnv();

const key = process.env.AI_API_KEY;
const provider = process.env.AI_PROVIDER;
const model = process.env.AI_MODEL || "gemini-3.8-flash";
if (!key) { console.log("AI_API_KEY is empty in .env"); process.exit(1); }
console.log(`Provider: ${provider}  Model: ${model}  Key: ${key.slice(0, 6)}… (${key.length} chars)\n`);

async function attempt(label, url, init) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    console.log(`[${label}] HTTP ${r.status} in ${Date.now() - t} ms`);
    console.log("   " + text.replace(/\s+/g, " ").slice(0, 300) + "\n");
  } catch (e) {
    console.log(`[${label}] FAILED after ${Date.now() - t} ms: ${e.name} ${e.cause?.code || e.cause?.message || e.message}\n`);
  }
}

if (provider === "gemini") {
  await attempt("1 list models", `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=5`, {});
  await attempt("2 native generate", `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with the word OK" }] }] }),
  });
  await attempt("3 openai-compatible (what the app uses)", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, reasoning_effort: "low", messages: [{ role: "user", content: "Reply with the word OK" }] }),
  });
} else {
  console.log("This test is for AI_PROVIDER=gemini");
}
