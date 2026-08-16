#!/usr/bin/env node
/**
 * Patches @supabase/supabase-js ESM bundle to remove the variable-named
 * dynamic import() that Hermes cannot parse.
 *
 * Problem: supabase-js ESM bundle contains a variable-named dynamic
 * import of OTEL_PKG ("@opentelemetry/api"). Hermes rejects this as
 * "Invalid expression", breaking the Supabase client internally.
 * getSession() hangs, onAuthStateChange emits erratic events, sessions
 * oscillate between null and real.
 *
 * Fix: Replace the dynamic import with Promise.resolve(null). OpenTelemetry
 * is optional tracing — the original code already has .catch(() => null)
 * for when OTel isn't installed, so a no-op is semantically identical.
 *
 * Idempotent (safe to run multiple times). Triggered by both postinstall
 * (local dev) and eas-build-post-install (EAS cloud builds).
 */
const fs = require("fs");
const path = require("path");

const esmPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@supabase",
  "supabase-js",
  "dist",
  "index.mjs"
);

if (!fs.existsSync(esmPath)) {
  console.log("[patch-supabase-otel] index.mjs not found, skipping");
  process.exit(0);
}

let content = fs.readFileSync(esmPath, "utf8");

if (content.includes("PATCHED_OTEL_IMPORT_REPLACED")) {
  console.log("[patch-supabase-otel] already patched, skipping");
  process.exit(0);
}

// Match: import( ... OTEL_PKG) — the [^)]* matches inline comments safely
const patched = content.replace(
  /import\([^)]*OTEL_PKG\)/g,
  "Promise.resolve(null) /* PATCHED_OTEL_IMPORT_REPLACED */"
);

if (patched === content) {
  console.log("[patch-supabase-otel] pattern not found, skipping");
  process.exit(0);
}

fs.writeFileSync(esmPath, patched, "utf8");
console.log("[patch-supabase-otel] patched dist/index.mjs successfully");
