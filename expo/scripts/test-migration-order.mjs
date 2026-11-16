#!/usr/bin/env node
/**
 * The order migrations run in decides which definition of a function is live. migration-tryal-friends.sql (Tryal friends + OPEN messages,
 * already applied to the live database) redefines functions that earlier files define; if any of those earlier files ever ran AFTER it, the
 * friends-only chat_conversation_for (and the older feed, dm policy ...) would come back. This test fails when the order allows that:
 * for every function migration-tryal-friends.sql redefines, every OTHER file that also defines it must come EARLIER in MIGRATIONS_ORDER.txt,
 * and in apply-migrations.mjs (FILES) wherever both are listed. Money's files must come after it.
 *   node --experimental-strip-types --no-warnings scripts/test-migration-order.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { FILES } from "./apply-migrations.mjs";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const dir = new URL("../supabase/", import.meta.url);
const order = readFileSync(new URL("MIGRATIONS_ORDER.txt", dir), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const defined = (file) => {
  const sql = readFileSync(new URL(file, dir), "utf8");
  return new Set([...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)\s*\(/gi)].map((m) => m[1].toLowerCase()));
};
const TF = "migration-tryal-friends.sql";
const idx = (list, f) => list.indexOf(f);

eq("migration-tryal-friends.sql is in both lists", [idx(order, TF) >= 0, idx(FILES, TF) >= 0], [true, true]);
eq("it runs AFTER migration-friends-messages.sql and migration-live-snapshot.sql in MIGRATIONS_ORDER.txt", [idx(order, TF) > idx(order, "migration-friends-messages.sql"), idx(order, TF) > idx(order, "migration-live-snapshot.sql")], [true, true]);
eq("it runs AFTER migration-live-snapshot.sql in apply-migrations.mjs (friends-messages is not re-applied by that script at all)", [idx(FILES, TF) > idx(FILES, "migration-live-snapshot.sql"), idx(FILES, "migration-friends-messages.sql")], [true, -1]);
eq("it runs after every other release file in apply-migrations.mjs except the later additions (post links, Money), which redefine none of its functions", FILES.filter((f) => idx(FILES, f) > idx(FILES, TF)).every((f) => f.startsWith("migration-money") || f === "migration-post-links.sql"), true);

const mine = defined(TF);
// Money's board migration deliberately carries copies of two of its functions (with the lines marked "-- MONEY" added: the campaign
// messaging exception). The next check makes sure those copies are exactly its versions plus the marked lines.
const MONEY_COPIES = new Set(["chat_check_stranger", "chat_messages_guard"]);
const clashes = [];
for (const f of readdirSync(dir).filter((n) => /^migration-.*\.sql$/.test(n) && n !== TF)) {
  const both = [...defined(f)].filter((n) => mine.has(n));
  for (const fn of both) {
    const iOther = idx(order, f), iMine = idx(order, TF);
    if (iOther < 0) continue;                          // not part of the ordered run (one-off files)
    if (f === "migration-money-board.sql" && MONEY_COPIES.has(fn)) continue;   // checked below
    if (iOther > iMine) clashes.push(`${f} (after ${TF}) redefines ${fn}`);
    const aOther = idx(FILES, f), aMine = idx(FILES, TF);
    if (aOther >= 0 && aMine >= 0 && aOther > aMine) clashes.push(`${f} (apply-migrations order) redefines ${fn}`);
  }
}
eq("no file that runs after it redefines a function it redefines (so chat_conversation_for etc. can never revert)", clashes, []);
ok: {
  const shared = [...mine].filter((n) => readdirSync(dir).some((f) => f !== TF && /^migration-.*\.sql$/.test(f) && defined(f).has(n)));
  eq("sanity: it does redefine chat_conversation_for (the friends-only one in migration-friends-messages.sql)", [mine.has("chat_conversation_for"), defined("migration-friends-messages.sql").has("chat_conversation_for"), shared.includes("chat_conversation_for")], [true, true, true]);
}
const body = (file, name) => {
  const sql = readFileSync(new URL(file, dir), "utf8");
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\s*\\(`, "i"));
  if (start < 0) return null;
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start) + 5);
  return sql.slice(start, end + 3);
};
const norm = (txt, dropMarked) => txt.split("\n").filter((l) => !(dropMarked && l.includes("-- MONEY"))).map((l) => l.trim()).filter(Boolean).join("\n");
for (const fn of MONEY_COPIES) {
  const theirs = body(TF, fn), copy = body("migration-money-board.sql", fn);
  eq(`money-board's copy of ${fn} is migration-tryal-friends.sql's version plus only the lines marked '-- MONEY'`, theirs && copy ? norm(copy, true) === norm(theirs, false) : false, true);
  eq(`...and it does carry the marked line(s)`, !!copy && /-- MONEY/.test(copy), true);
}
const MONEY = order.filter((f) => f.startsWith("migration-money"));
eq("Money's migrations (when present) come after it", MONEY.every((f) => idx(order, f) > idx(order, TF)), true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
