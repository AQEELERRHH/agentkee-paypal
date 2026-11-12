// Deterministic verification engine. Pure code, no AI: every record is checked
// against the agreement's measurable acceptance criteria and every rejection
// carries the exact rule and reason. Accepted counts come only from here.
import { parseCSV } from "./csv.js";

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const DISPOSABLE = new Set([
  "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com", "yopmail.com",
  "trashmail.com", "fakeinbox.com", "throwawaymail.com", "example.com", "test.com",
]);

export const RULES = {
  required_fields: "All required fields present and non-empty",
  email_valid: "Email is syntactically valid and not a disposable/placeholder domain",
  phone_e164: "Phone number is in international E.164 format",
  country_allowed: "Country is in the agreed target markets",
  website_valid: "Website is a valid https URL",
  email_matches_website: "Email domain matches the company website domain",
  no_duplicates: "Record is not a duplicate (email) of an earlier record",
};

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch { return null; }
}

// Full per-record verdicts (used by the records grid). Same engine, same rules.
export function verifyRecords(csvText, agreement) {
  const v = verifyDelivery(csvText, agreement, { includeAll: true });
  return { header: v.header, schema: agreement.criteria.schema, rules: RULES, records: v.records };
}

export function verifyDelivery(csvText, agreement, opts = {}) {
  const started = Date.now();
  const { header, records } = parseCSV(csvText || "");
  const c = agreement.criteria;
  const missingCols = c.schema.filter((col) => !header.includes(col));
  const findings = [];
  const ruleFailures = Object.fromEntries(Object.keys(RULES).map((k) => [k, 0]));
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  const all = []; // every record with its verdict, for the records grid

  if (missingCols.length) {
    // Schema breach: the delivery does not match the agreed format at all.
    findings.push({ level: "critical", rule: "schema", message: `Missing agreed columns: ${missingCols.join(", ")}` });
  }

  for (const r of records) {
    const reasons = [];
    if (missingCols.length) {
      reasons.push({ rule: "schema", detail: "Delivery does not follow the agreed schema" });
    } else {
      const empty = c.required_fields.filter((f) => !r[f]);
      if (empty.length) reasons.push({ rule: "required_fields", detail: `Empty: ${empty.join(", ")}` });

      const email = (r.email || "").toLowerCase();
      const domain = email.split("@")[1] || "";
      if (r.email && (!EMAIL.test(email) || DISPOSABLE.has(domain)))
        reasons.push({ rule: "email_valid", detail: `Invalid or placeholder email "${r.email}"` });

      if (r.phone && !E164.test(r.phone.replace(/[\s-]/g, "")))
        reasons.push({ rule: "phone_e164", detail: `"${r.phone}" is not E.164` });

      if (r.country && !c.allowed_countries.includes(r.country.toUpperCase()))
        reasons.push({ rule: "country_allowed", detail: `${r.country} is outside agreed markets (${c.allowed_countries.join(", ")})` });

      const host = r.website ? hostOf(r.website) : null;
      if (r.website && !host) reasons.push({ rule: "website_valid", detail: `"${r.website}" is not a valid https URL` });

      if (c.email_matches_website && host && domain && EMAIL.test(email) && !(domain === host || domain.endsWith("." + host) || host.endsWith("." + domain)))
        reasons.push({ rule: "email_matches_website", detail: `Email domain ${domain} ≠ website ${host}` });

      if (email && seen.has(email)) reasons.push({ rule: "no_duplicates", detail: `Duplicate of an earlier record (${email})` });
      if (email) seen.add(email);
    }

    if (reasons.length) {
      for (const x of reasons) if (x.rule in ruleFailures) ruleFailures[x.rule]++;
      rejected.push({ row: r.__row, id: r.id || null, reasons });
    } else accepted.push(r);
    const { __row, __extra, ...fields } = r;
    all.push({
      row: __row,
      status: reasons.length ? "rejected" : accepted.length > agreement.quantity ? "extra" : "passed",
      rules: reasons.map((x) => x.rule),
      reasons: reasons.map((x) => x.detail),
      ...fields,
    });
  }

  const delivered = records.length;
  const promised = agreement.quantity;
  if (delivered < promised)
    findings.push({ level: "warning", rule: "quantity", message: `Short delivery: ${delivered} records delivered, ${promised} promised` });
  if (delivered > promised)
    findings.push({ level: "info", rule: "quantity", message: `${delivered - promised} extra records delivered; only ${promised} are payable` });

  const acceptedCount = Math.min(accepted.length, promised);
  return {
    engine: "agentkee-verify/1.0 (deterministic)",
    duration_ms: Date.now() - started,
    header,
    delivered,
    promised,
    accepted: acceptedCount,
    rejected: rejected.length,
    acceptance_ratio: promised ? acceptedCount / promised : 0,
    rule_failures: ruleFailures,
    rules: RULES,
    findings,
    rejected_sample: rejected.slice(0, 40),
    accepted_sample: accepted.slice(0, 25).map(({ __row, __extra, ...rest }) => rest),
    ...(opts.includeAll ? { records: all } : {}),
  };
}
