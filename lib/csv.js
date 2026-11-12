// Small RFC-4180 CSV parser/serializer (handles quotes, commas, CRLF).
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
    i++;
  }
  if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((r, idx) => {
    const o = { __row: idx + 2 };
    header.forEach((h, j) => (o[h] = (r[j] ?? "").trim()));
    o.__extra = r.length > header.length;
    return o;
  });
  return { header, records };
}

const esc = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function toCSV(header, records) {
  return [header.join(","), ...records.map((r) => header.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}
