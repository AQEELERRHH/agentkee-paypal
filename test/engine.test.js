import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyDelivery } from "../lib/verify.js";
import { decide } from "../lib/decide.js";
import { draftAgreement, SELLERS } from "../lib/agents.js";

const okAI = { status: "ok", result: { semantic_match: true, confidence: 0.9, concerns: [], summary: "" } };
const agreement = (id) => draftAgreement({ seller: SELLERS[id], quantity: 1000, unit_price_cents: 1 });
const run = (id, ai = okAI) => {
  const a = agreement(id);
  const v = verifyDelivery(readFileSync(SELLERS[id].file, "utf8"), a);
  return { v, d: decide(a, v, ai) };
};

test("Ledgerline: 1000/1000 accepted → capture full $10.00", () => {
  const { v, d } = run("ledgerline");
  assert.equal(v.delivered, 1000);
  assert.equal(v.accepted, 1000);
  assert.equal(d.action, "CAPTURE_FULL");
  assert.equal(d.capture_cents, 1000);
  assert.equal(d.release_cents, 0);
  assert.equal(d.requires_human_review, false);
});

test("LeadSprint: 720/1000 accepted → capture $7.20, release $2.80", () => {
  const { v, d } = run("leadsprint");
  assert.equal(v.accepted, 720);
  assert.equal(v.rejected, 280);
  assert.equal(d.action, "CAPTURE_PARTIAL");
  assert.equal(d.capture_cents, 720);
  assert.equal(d.release_cents, 280);
  const failures = Object.values(v.rule_failures).reduce((a, b) => a + b, 0);
  assert.ok(failures >= 280, "every rejected record names at least one rule");
});

test("BulkReach: 0/1000 accepted → void", () => {
  const { v, d } = run("bulkreach");
  assert.equal(v.accepted, 0);
  assert.equal(d.action, "VOID");
  assert.equal(d.capture_cents, 0);
  assert.equal(d.release_cents, 1000);
});

test("Below minimum acceptance ratio → void", () => {
  const a = agreement("leadsprint");
  a.criteria.min_acceptance_ratio = 0.8;
  const v = verifyDelivery(readFileSync(SELLERS.leadsprint.file, "utf8"), a);
  assert.equal(decide(a, v, okAI).action, "VOID");
});

test("AI cannot change the amount; low confidence escalates to human review", () => {
  const { d } = run("leadsprint", { status: "ok", result: { semantic_match: true, confidence: 0.3, concerns: [], summary: "" } });
  assert.equal(d.capture_cents, 720);
  assert.equal(d.requires_human_review, true);
});

test("AI not configured → paying actions need a human, voids do not", () => {
  assert.equal(run("leadsprint", { status: "not_configured" }).d.requires_human_review, true);
  assert.equal(run("bulkreach", { status: "not_configured" }).d.requires_human_review, false);
});

test("Wrong schema → every record rejected", () => {
  const a = agreement("ledgerline");
  const v = verifyDelivery("name,mail\nA,a@b.co\n", a);
  assert.equal(v.accepted, 0);
  assert.equal(v.findings[0].level, "critical");
});

test("Extra records beyond the agreed quantity are not payable", () => {
  const a = draftAgreement({ seller: SELLERS.ledgerline, quantity: 100, unit_price_cents: 5 });
  const v = verifyDelivery(readFileSync(SELLERS.ledgerline.file, "utf8"), a);
  const d = decide(a, v, okAI);
  assert.equal(v.accepted, 100);
  assert.equal(d.capture_cents, 500);
});

test("Records grid data matches the verification totals", async () => {
  const { verifyRecords } = await import("../lib/verify.js");
  const a = agreement("leadsprint");
  const r = verifyRecords(readFileSync(SELLERS.leadsprint.file, "utf8"), a);
  assert.equal(r.records.length, 1000);
  assert.equal(r.records.filter((x) => x.status === "passed").length, 720);
  assert.equal(r.records.filter((x) => x.status === "rejected").length, 280);
  assert.ok(r.records.filter((x) => x.status === "rejected").every((x) => x.reasons.length > 0));
});

test("Over-delivery: grid labels payable rows 'passed' and the excess 'extra'", async () => {
  const { verifyRecords, verifyDelivery } = await import("../lib/verify.js");
  const a = draftAgreement({ seller: SELLERS.ledgerline, quantity: 100, unit_price_cents: 5 });
  const csv = readFileSync(SELLERS.ledgerline.file, "utf8");
  const r = verifyRecords(csv, a), v = verifyDelivery(csv, a);
  const passed = r.records.filter((x) => x.status === "passed").length;
  assert.equal(passed, v.accepted); // the Passed badge uses v.accepted
  assert.equal(passed, 100);
  assert.equal(r.records.filter((x) => x.status === "extra").length, v.delivered - v.accepted - v.rejected);
});
