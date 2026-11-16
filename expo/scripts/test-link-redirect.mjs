#!/usr/bin/env node
/**
 * The tracked short link (supabase/functions/go/core.ts): finding the code, counting only real browsers, the salted fingerprint that is the only
 * thing sent to the database, the redirect, and that nothing about the person is logged or stored.
 *   node --experimental-strip-types --no-warnings scripts/test-link-redirect.mjs
 */
import { readFileSync } from "node:fs";
import { BOT_RE, clientAddress, codeFromUrl, fingerprint, handle, isCountable, safeTarget } from "../supabase/functions/go/core.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const BASE = "https://x.supabase.co/functions/v1/go";
const CODE = "0123456789";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ── the code ──
eq("the code is the last path piece, or ?c=", [codeFromUrl(`${BASE}/${CODE}`), codeFromUrl(`${BASE}/${CODE}/`), codeFromUrl(`${BASE}?c=${CODE}`), codeFromUrl(`${BASE}/ABCDEF0123`)], [CODE, CODE, CODE, "abcdef0123"]);
eq("anything else is not a code", [codeFromUrl(BASE), codeFromUrl(`${BASE}/short`), codeFromUrl(`${BASE}/${CODE}0`), codeFromUrl(`${BASE}/zzzzzzzzzz`), codeFromUrl(`${BASE}/../../etc`), codeFromUrl("not a url")], [null, null, null, null, null, null]);

// ── who counts ──
eq("a normal browser GET counts", isCountable("GET", SAFARI), true);
eq("HEAD (link checkers), POST and a missing or empty browser string do not", [isCountable("HEAD", SAFARI), isCountable("POST", SAFARI), isCountable("GET", null), isCountable("GET", "  ")], [false, false, false, false]);
eq("chat-app previews, crawlers and scripts follow the link but do not count", ["WhatsApp/2.23 A", "Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "Twitterbot/1.0", "Googlebot/2.1", "Discordbot/2.0", "TelegramBot (like TwitterBot)", "curl/8.4", "python-requests/2.31", "iMessage LinkPresentation preview"].map((ua) => isCountable("GET", ua)), Array(10).fill(false));
eq("the bot pattern does not catch ordinary phones", [!BOT_RE.test(SAFARI), !BOT_RE.test("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")], [true, true]);

// ── the caller's address and the fingerprint ──
eq("the address: first of x-forwarded-for, else the platform's own headers", [clientAddress(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), clientAddress(new Headers({ "cf-connecting-ip": "198.51.100.4" })), clientAddress(new Headers())], ["203.0.113.9", "198.51.100.4", ""]);
const f1 = await fingerprint("secret-1", "203.0.113.9", SAFARI);
eq("the fingerprint is 32 hex characters, the same for the same device and secret", [/^[0-9a-f]{32}$/.test(f1), f1 === (await fingerprint("secret-1", "203.0.113.9", SAFARI))], [true, true]);
eq("another address, another browser or another secret gives another fingerprint", [f1 === (await fingerprint("secret-1", "203.0.113.10", SAFARI)), f1 === (await fingerprint("secret-1", "203.0.113.9", SAFARI + " x")), f1 === (await fingerprint("secret-2", "203.0.113.9", SAFARI))], [false, false, false]);
eq("the fingerprint does not contain the address or the browser string", [f1.includes("203"), f1.includes("Safari")], [false, false]);

// ── the redirect ──
eq("only an https address without a login in it is followed", [safeTarget("https://youtu.be/x"), safeTarget("http://youtu.be/x"), safeTarget("javascript:alert(1)"), safeTarget("https://a:b@youtu.be/x"), safeTarget(null), safeTarget("")], ["https://youtu.be/x", null, null, null, null, null]);
const mk = (over = {}) => {
  const calls = { lookup: [], record: [] };
  const deps = {
    salt: "salty",
    lookup: async (c) => { calls.lookup.push(c); return over.lookup === undefined ? { url: "https://www.youtube.com/watch?v=abc" } : over.lookup === "throw" ? (() => { throw new Error("db down"); })() : over.lookup; },
    record: async (c, fp) => { calls.record.push([c, fp]); if (over.record === "throw") throw new Error("db down"); return true; },
    ...(over.salt !== undefined ? { salt: over.salt } : {}),
  };
  return { deps, calls };
};
const req = (path = CODE, init = {}) => new Request(`${BASE}/${path}`, { headers: { "user-agent": SAFARI, "x-forwarded-for": "203.0.113.9", ...(init.headers ?? {}) }, method: init.method ?? "GET" });
{
  const { deps, calls } = mk();
  const res = await handle(req(), deps);
  eq("a person's tap: 302 to the video, counted once with a 32-character fingerprint only", [res.status, res.headers.get("location"), calls.record.length, calls.record[0]?.[0], /^[0-9a-f]{32}$/.test(calls.record[0]?.[1] ?? "")], [302, "https://www.youtube.com/watch?v=abc", 1, CODE, true]);
  eq("the redirect is never cached, sends no referrer and is not indexed", [res.headers.get("cache-control"), res.headers.get("referrer-policy"), res.headers.get("x-robots-tag")], ["no-store", "no-referrer", "noindex"]);
  eq("what the database receives contains neither the address nor the browser", JSON.stringify(calls.record).includes("203.0.113.9") || JSON.stringify(calls.record).includes("Safari"), false);
}
{
  const { deps, calls } = mk();
  const res = await handle(req(CODE, { method: "HEAD" }), deps);
  eq("a HEAD request redirects but does not count", [res.status, calls.record.length], [302, 0]);
}
{
  const { deps, calls } = mk();
  const res = await handle(req(CODE, { headers: { "user-agent": "WhatsApp/2.23" } }), deps);
  eq("a chat-app preview redirects but does not count", [res.status, calls.record.length], [302, 0]);
}
{
  const { deps, calls } = mk({ salt: null });
  const res = await handle(req(), deps);
  eq("without the LINK_SALT secret the link still works and nothing is counted (it never counts without hashing)", [res.status, calls.record.length], [302, 0]);
}
{
  const { deps } = mk({ record: "throw" });
  const res = await handle(req(), deps);
  eq("if counting fails the person still gets to the video", res.status, 302);
}
{
  const { deps } = mk({ lookup: null });
  const res = await handle(req(), deps);
  eq("an unknown, hidden or cleared link is a plain 404", [res.status, res.headers.get("content-type"), await res.text()], [404, "text/plain; charset=utf-8", "This link isn't available."]);
}
{
  const { deps } = mk({ lookup: "throw" });
  eq("a database error is a 404, never a crash", (await handle(req(), deps)).status, 404);
}
{
  const { deps, calls } = mk({ lookup: { url: "http://youtube.com/x" } });
  const res = await handle(req(), deps);
  eq("an address that is not https is never followed, and nothing is counted", [res.status, calls.record.length], [404, 0]);
}
{
  const { deps, calls } = mk();
  const res = await handle(req("nope"), deps);
  eq("a path that is not a code never reaches the database", [res.status, calls.lookup.length], [404, 0]);
}

// ── nothing about the person is logged or kept ──
const core = readFileSync(new URL("../supabase/functions/go/core.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../supabase/functions/go/index.ts", import.meta.url), "utf8");
eq("the function never logs or stores anything (no console, no storage, no cookies, no analytics call)", /console\.|localStorage|Deno\.kv|setCookie|set-cookie|navigator\.sendBeacon|fetch\(["'`]http/.test(core + index.replace(/fetch\(`\$\{base\}/g, "")), false);
eq("the only database calls are the two functions the migration gives the service role", [...index.matchAll(/rpc<[^(]*\("([a-z_]+)"/g)].map((m) => m[1]).sort(), ["link_target", "record_link_tap"]);
eq("it is deployed without a gateway login (a browser opens it) and is listed for ship.sh", [/--no-verify-jwt/.test(index), /^go\s+--no-verify-jwt/m.test(readFileSync(new URL("../supabase/FUNCTIONS.txt", import.meta.url), "utf8"))], [true, true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
