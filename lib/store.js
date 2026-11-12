// Durable JSON-file store. Every purchase, agreement, delivery, verification,
// AI assessment, decision and PayPal event is persisted and survives restarts.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const FILE = process.env.DATA_FILE || "data/db.json";

function load() {
  if (!existsSync(FILE)) return { purchases: {} };
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch (e) {
    throw new Error(`Data file ${FILE} is corrupt: ${e.message}`);
  }
}

let db = load();

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, FILE); // atomic replace
}

export function createPurchase(data) {
  const id = "pk_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const now = new Date().toISOString();
  db.purchases[id] = { id, created_at: now, updated_at: now, events: [], ...data };
  save();
  return db.purchases[id];
}

export function getPurchase(id) {
  return db.purchases[id] || null;
}

export function listPurchases() {
  return Object.values(db.purchases).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function updatePurchase(id, patch) {
  const p = db.purchases[id];
  if (!p) throw new Error(`Unknown purchase ${id}`);
  Object.assign(p, patch, { updated_at: new Date().toISOString() });
  save();
  return p;
}

export function addEvent(id, type, actor, detail = {}) {
  const p = db.purchases[id];
  if (!p) throw new Error(`Unknown purchase ${id}`);
  p.events.push({ ts: new Date().toISOString(), type, actor, detail });
  p.updated_at = new Date().toISOString();
  save();
}

// Large artifacts (delivered files) are stored beside the db, not inline.
export function saveArtifact(id, name, content) {
  const path = `${dirname(FILE)}/artifacts/${id}-${name}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function readArtifact(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
