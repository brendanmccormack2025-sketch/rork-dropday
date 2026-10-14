#!/usr/bin/env node
/**
 * The product is called Tryal. No user-facing string may still say "Trial": string literals with words in them (not
 * ids, keys, paths or imports), JSX text, app.json texts, the legal text. Internal names (the status 'trial', file and
 * identifier names, storage keys, ids) are allowed: a literal with no whitespace is an identifier, never copy.
 *   node --experimental-strip-types --no-warnings scripts/test-brand-name.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");

const DIRS = ["app", "components", "lib", "providers", "hooks", "constants", "legacy"];
function files(dir) {
  const out = [];
  for (const f of readdirSync(join(root, dir))) {
    const p = join(dir, f);
    const st = statSync(join(root, p));
    if (st.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

// Comments are not user-facing; strip them (keeping string contents intact).
function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i + 2);
      i = j < 0 ? src.length : j + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const WORD = /\btrials?\b/i;
const hits = [];
for (const dir of DIRS) for (const p of files(dir)) {
  const src = stripComments(read(p));
  // string literals
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const lit = m[1] ?? m[2] ?? m[3] ?? "";
    if (!WORD.test(lit)) continue;
    // a literal with no whitespace is an identifier (status, id, key, path, import): allowed, unless it is the capitalised word itself
    if (!/\s/.test(lit) && !/^(Trials?|TRIALS?)$/.test(lit)) continue;
    hits.push(`${p}: ${lit.slice(0, 90)}`);
  }
  // JSX text
  for (const m of src.matchAll(/>([^<>{}\n]*\btrials?\b[^<>{}\n]*)</gi)) hits.push(`${p}: (JSX) ${m[1].trim().slice(0, 90)}`);
}
eq("no user-facing string in the app says Trial (literals with words, JSX text, labels)", hits, []);

eq("no user-facing string uses Tryal as a plural noun (\"Tryals\"): plain words instead", hits.length === 0 && DIRS.flatMap(files).filter((p) => /\bTryals\b/.test(stripComments(read(p)))), []);

// the operating entity is the owner's real legal name until the LLC exists; Tryal stays the app / service name
const legal = read("constants/legal.ts");
eq("legal text: the operator is Brendan McCormack (\"Tryal\", \"we\") in the Terms and the Privacy Policy", (legal.match(/Brendan McCormack \(\\"Tryal\\", \\"we,\\"/g) ?? []).length, 2);
eq("legal text: nothing is 'operated by Tryal'", /operated by Tryal/.test(legal) || /^\s*"Tryal \(\\"we/m.test(legal), false);

// app.json: the name and every permission text
const app = JSON.parse(read("app.json")).expo;
const strings = [];
(function walk(v, path) {
  if (typeof v === "string") strings.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
})(app, "expo");
eq("app.json: no text says Trial", strings.filter(([, v]) => /\bTrial\b/.test(v)).map(([k, v]) => `${k}: ${v}`), []);
eq("app name under the icon is Tryal", app.name, "Tryal");
eq("slug, scheme, bundle id and package are unchanged", [app.slug, app.scheme, app.ios?.bundleIdentifier, app.android?.package].every((v) => v === undefined || /^[a-z0-9.\-_]+$/.test(v) && !/tryal/i.test(v)), true);
eq("version is 1.0.5", app.version, "1.0.5");
const infoPlist = app.ios?.infoPlist ?? {};
eq("every NS*UsageDescription says Tryal", Object.entries(infoPlist).filter(([k]) => /^NS.*UsageDescription$/.test(k)).every(([, v]) => /\bTryal\b/.test(v)), true);

// wordmarks
for (const f of ["tryal-wordmark.png", "tryal-wordmark-white.png", "trial-wordmark.png"]) eq(`${f} exists`, existsSync(join(root, "assets/images", f)), true);
const dark = ["app/(tabs)/index.tsx"], light = ["app/(auth)/welcome.tsx", "app/(auth)/sign-up.tsx", "app/(auth)/sign-in.tsx"];
for (const p of light) eq(`${p} uses the dark-on-light wordmark`, /tryal-wordmark\.png/.test(read(p)) && !/trial-wordmark/.test(read(p)), true);
for (const p of dark) eq(`${p} (feed header over video) uses the white wordmark`, /tryal-wordmark-white\.png/.test(read(p)) && !/trial-wordmark/.test(read(p)), true);
eq("the splash (light background) uses the dark wordmark", /tryal-wordmark\.png/.test(JSON.stringify(app.plugins)), true);

// nothing internal was renamed
const posts = read("providers/PostsProvider.tsx");
eq("the stored status is still 'trial'", /status === "trial"/.test(posts) && /"trial", "incomplete", "survived"/.test(posts), true);
eq("internal file names are unchanged", ["lib/trialEngine.ts", "components/TrialStatusBadge.tsx", "app/settings/hide-trials.tsx"].every((p) => existsSync(join(root, p))), true);
eq("the old wordmark file is kept", existsSync(join(root, "assets/images/trial-wordmark.png")), true);

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
