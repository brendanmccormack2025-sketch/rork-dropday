#!/usr/bin/env node
/**
 * Runs SQL on the Supabase project through the Management API (no psql, no database password):
 *   POST https://api.supabase.com/v1/projects/<ref>/database/query     Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
 *
 *   node scripts/supabase-sql.mjs file  <path.sql>     run a whole migration file as ONE request
 *   node scripts/supabase-sql.mjs query "<sql>"        run a short query and print the result rows as JSON
 *
 * The token comes from the SUPABASE_ACCESS_TOKEN environment variable (whitespace stripped) and is never printed.
 * On an error the API's own message is printed to stderr and the exit code is 1. A file is sent as one query, so
 * the database runs its statements as one implicit transaction: a failing migration changes nothing.
 * SUPABASE_API_BASE (default https://api.supabase.com) and SUPABASE_PROJECT_REF exist for the tests.
 */
import { readFileSync } from "node:fs";

const BASE = (process.env.SUPABASE_API_BASE || "https://api.supabase.com").replace(/\/+$/, "");
const REF = process.env.SUPABASE_PROJECT_REF || "tfdjymogbtfavdzgfqas";
/** Larger than this is refused up front: split the migration instead of sending it. */
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 5 * 60 * 1000;

const token = (process.env.SUPABASE_ACCESS_TOKEN || "").replace(/\s+/g, "");
const [mode, arg] = process.argv.slice(2);

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}
if (!token) die("SUPABASE_ACCESS_TOKEN is not set");
if (mode !== "file" && mode !== "query") die('usage: supabase-sql.mjs file <path.sql> | query "<sql>"', 2);
if (!arg) die("missing argument", 2);

let sql;
try {
  sql = mode === "file" ? readFileSync(arg, "utf8") : arg;
} catch (e) {
  die(`cannot read ${arg}: ${e.message}`);
}
const body = JSON.stringify({ query: sql });
const bytes = Buffer.byteLength(body);
if (bytes > MAX_BYTES) {
  die(`TOO LARGE for one request: ${arg} is ${bytes} bytes (limit used here: ${MAX_BYTES}). Split the migration into smaller files.`);
}

/** The API's error text, whatever shape it comes in (never includes the token: only the response is read). */
function apiMessage(text) {
  try {
    const j = JSON.parse(text);
    return j.message || j.error || (typeof j === "string" ? j : JSON.stringify(j));
  } catch {
    return text.trim().slice(0, 2000) || "(empty response)";
  }
}

let res;
try {
  res = await fetch(`${BASE}/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (e) {
  die(`request failed: ${e?.name === "TimeoutError" ? `no answer after ${TIMEOUT_MS / 1000} s (the migration may be too slow for one request)` : e?.message || e}`);
}
const text = await res.text();
if (!res.ok) {
  if (res.status === 413) die(`TOO LARGE for one request (HTTP 413): ${arg} is ${bytes} bytes. Split the migration into smaller files.`);
  die(`API error (HTTP ${res.status}): ${apiMessage(text)}`);
}
if (mode === "query") {
  process.stdout.write(text.trim() + "\n");
} else {
  console.log(`ok (${bytes} bytes, HTTP ${res.status})`);
}
