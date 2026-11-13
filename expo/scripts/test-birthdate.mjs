#!/usr/bin/env node
/**
 * Money step 2, the app side: birthdate entry (lib/birthdate.ts), my_features parsing (lib/moneyFeatures.ts), and that the app
 * no longer writes or selects the private birthdate column directly.
 *   node --experimental-strip-types --no-warnings scripts/test-birthdate.mjs
 */
import { readFileSync } from "node:fs";
import { ageTierOf, birthdateServerError, parseBirthdate, signUpAgeError, toIso } from "../lib/birthdate.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const TODAY = new Date(2026, 10, 13); // 13 Nov 2026 (local)

// ── real calendar dates only ──
eq("toIso pads and accepts real dates", [toIso(1990, 1, 5), toIso(2000, 2, 29), toIso(2026, 11, 13)], ["1990-01-05", "2000-02-29", "2026-11-13"]);
eq("toIso rejects Feb 30, Feb 29 in a non-leap year, month 13, day 0, year before 1900", [toIso(1990, 2, 30), toIso(2001, 2, 29), toIso(1990, 13, 1), toIso(1990, 1, 0), toIso(1899, 12, 31)], [null, null, null, null, null]);
eq("toIso rejects non-integers", [toIso(1990.5, 1, 1), toIso(NaN, 1, 1)], [null, null]);

// ── the tiers match the server's age_tier(), to the day ──
eq("exactly 18 today: adult", ageTierOf("2008-11-13", TODAY), "adult");
eq("turns 18 tomorrow: teen", ageTierOf("2008-11-14", TODAY), "teen");
eq("turned 18 yesterday: adult", ageTierOf("2008-11-12", TODAY), "adult");
eq("exactly 13 today: teen; 13 tomorrow: under_13", [ageTierOf("2013-11-13", TODAY), ageTierOf("2013-11-14", TODAY)], ["teen", "under_13"]);
eq("a leap-day birthday counts on the day (born 2008-02-29, 18 in Mar 2026)", ageTierOf("2008-02-29", new Date(2026, 2, 1)), "adult");
eq("missing or malformed: unknown (never adult)", [ageTierOf(null, TODAY), ageTierOf("", TODAY), ageTierOf("1990/01/01", TODAY), ageTierOf("garbage", TODAY)], ["unknown", "unknown", "unknown", "unknown"]);

// ── what people type ──
eq("valid adult", parseBirthdate("1", "5", "1990", TODAY), { ok: true, iso: "1990-01-05", tier: "adult" });
eq("valid teen", parseBirthdate("06", "15", "2010", TODAY), { ok: true, iso: "2010-06-15", tier: "teen" });
eq("valid under 13", parseBirthdate("06", "15", "2018", TODAY), { ok: true, iso: "2018-06-15", tier: "under_13" });
eq("empty fields", parseBirthdate("", "5", "1990", TODAY).ok, false);
eq("letters", parseBirthdate("ab", "5", "1990", TODAY).ok, false);
eq("a 2-digit year is refused (no guessing the century)", parseBirthdate("1", "5", "90", TODAY).ok, false);
eq("Feb 30 is refused with the date message", parseBirthdate("2", "30", "1990", TODAY), { ok: false, error: "That date doesn't exist. Check the month, day and year." });
eq("a date in the future is refused, today is not", [parseBirthdate("11", "14", "2026", TODAY).ok, parseBirthdate("11", "13", "2026", TODAY).ok], [false, true]);
eq("spaces around are fine", parseBirthdate(" 1 ", " 5 ", " 1990 ", TODAY).ok, true);
eq("sign-up blocks under 13 only (teens may sign up; Money still refuses them on the server)", [signUpAgeError("under_13"), signUpAgeError("teen"), signUpAgeError("adult")], ["You must be 13 or older to use Tryal.", null, null]);

// ── the server's refusals become plain messages ──
eq("server messages", [birthdateServerError("birthdate is already set"), birthdateServerError("birthdate is not available yet"), birthdateServerError("invalid birthdate"), birthdateServerError("boom"), birthdateServerError(null)],
  ["Your birthdate is already saved.", "This isn't available yet. Try again later.", "That date doesn't look right.", "Couldn't save your birthdate. Check your connection and try again.", "Couldn't save your birthdate. Check your connection and try again."]);

// ── the app never writes or selects the private column directly ──
const auth = read("../providers/AuthProvider.tsx");
eq("sign-up sends the birthdate as metadata only, never in a direct profile update", [/update\.birthdate/.test(auth), /birthdate: birthdate \?\? undefined/.test(auth)], [false, true]);
const posts = read("../providers/PostsProvider.tsx");
eq("the profile query does not select birthdate; my own comes from my_birthdate()", [/\$\{profileLinkColumns\(\)\}, birthdate/.test(posts), /rpc\("my_birthdate"\)/.test(posts)], [false, true]);
const signUp = read("../app/(auth)/sign-up.tsx");
eq("sign-up asks for a birthdate and passes the validated ISO date", [/parseBirthdate\(bdMonth, bdDay, bdYear\)/.test(signUp), /signUpWithEmail\(email, password, username, bd\.iso,/.test(signUp)], [true, true]);

// ── nothing else in the app touches the column ──
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const hits = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    if (["node_modules", ".git", "scripts", "supabase", "ios", "android", "dist"].includes(f)) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const t = readFileSync(p, "utf8");
    if (/from\("profiles"\)[\s\S]{0,200}?\.(update|upsert|insert)\([^)]*birthdate/.test(t)) hits.push(p.replace(root, ""));
  }
})(root);
eq("no app file writes birthdate to profiles directly", hits, []);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
