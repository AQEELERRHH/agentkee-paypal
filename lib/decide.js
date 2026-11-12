// Decision engine. Deterministic code computes the payable amount from verified
// counts. AI can only *escalate* a decision to human review — it can never
// raise, lower or invent the amount.
import { centsToStr } from "./env.js";

export function decide(agreement, verification, ai) {
  const unit = agreement.unit_price_cents;
  const authorized = agreement.quantity * unit;
  const payable = verification.accepted * unit;
  const ratio = verification.acceptance_ratio;
  const min = agreement.criteria.min_acceptance_ratio;

  let action, reason;
  if (verification.accepted === 0) {
    action = "VOID";
    reason = "No records passed verification. Nothing is owed; the authorization is voided.";
  } else if (ratio < min) {
    action = "VOID";
    reason = `Only ${(ratio * 100).toFixed(1)}% passed, below the agreed minimum of ${(min * 100).toFixed(0)}%. Delivery rejected.`;
  } else if (verification.accepted >= agreement.quantity) {
    action = "CAPTURE_FULL";
    reason = `All ${agreement.quantity} records passed verification.`;
  } else {
    action = "CAPTURE_PARTIAL";
    reason = `${verification.accepted} of ${agreement.quantity} records passed. Pay for verified records only; release the rest.`;
  }

  const amount = action === "VOID" ? 0 : action === "CAPTURE_FULL" ? authorized : payable;

  // Escalation to a human: configured policy, AI concern, or AI unavailable.
  const escalations = [];
  if (agreement.review_mode === "always") escalations.push("Buyer policy: human approves every payment");
  if (ai?.status === "ok" && ai.result) {
    if (ai.result.semantic_match === false) escalations.push("AI flagged that accepted records may not match the agreed purpose");
    if (typeof ai.result.confidence === "number" && ai.result.confidence < 0.6)
      escalations.push(`AI confidence ${ai.result.confidence.toFixed(2)} is below 0.60`);
  } else if (action !== "VOID") {
    escalations.push(ai?.status === "not_configured"
      ? "AI semantic check not configured — human confirmation required before paying"
      : `AI semantic check failed (${ai?.error || "unknown error"}) — human confirmation required`);
  }

  return {
    engine: "agentkee-decide/1.0 (deterministic)",
    action,
    reason,
    unit_price: centsToStr(unit),
    authorized_cents: authorized,
    capture_cents: amount,
    release_cents: authorized - amount,
    math: action === "VOID"
      ? `0 payable → void $${centsToStr(authorized)} hold`
      : `${action === "CAPTURE_FULL" ? agreement.quantity : verification.accepted} × $${centsToStr(unit)} = $${centsToStr(amount)} captured, $${centsToStr(authorized - amount)} released`,
    requires_human_review: escalations.length > 0,
    escalations,
  };
}
