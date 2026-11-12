// Minimal .env loader (no dependency). Real environment variables always win.
import { readFileSync, existsSync } from "node:fs";

export function loadEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, "");
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export const centsToStr = (c) => (c / 100).toFixed(2);
