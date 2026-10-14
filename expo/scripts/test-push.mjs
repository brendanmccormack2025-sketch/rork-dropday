#!/usr/bin/env node
/**
 * Push notifications: notification rows -> Expo messages (every type, grouping, minors), what to do with Expo's tickets and
 * receipts (dead tokens removed, failures retried), the settings model, and that the app registers and removes its token.
 * The database half (claiming, settings, milestones, tokens) runs on a real Postgres in test-push-sql.mjs.
 *   node --experimental-strip-types --no-warnings scripts/test-push.mjs
 */
import { readFileSync } from "node:fs";
import { buildPushes, chunk, interpretReceipts, interpretTickets, routeFor, toExpoMessages } from "../supabase/functions/send-push/map.ts";
import { DEFAULT_PUSH_PREFS, EXPO_TOKEN_RE, PUSH_PREF_ROWS, normalizePrefs, routeFromPushData } from "../lib/pushCore.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const P = (n) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;
const TOKEN = (n) => `ExponentPushToken[token${n}]`;
let seq = 0;
const row = (over = {}) => ({ id: `n${++seq}`, type: "reaction", recipient_id: U(1), actor_id: U(2), post_id: P(1), created_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, attempts: 1, actor_name: "Ana", recipient_minor: false, tokens: [TOKEN(1)], milestone: null, last_was_post: null, preview: null, ...over });
const one = (r) => buildPushes([r])[0];

// ── mapping, every type ──
eq("survived", [one(row({ type: "verdict_survived", actor_id: null })).title, one(row({ type: "verdict_survived", actor_id: null })).body], ["Tryal", "Your post survived Tryal 🏆"]);
eq("reaction", [one(row()).title, one(row()).body], ["Tryal", "Ana reacted to your post"]);
eq("a reply to my reaction", one(row({ on_reaction: true })).body, "Ana replied to your reaction");
for (const [m, text] of [[1, "Your post got its first like"], [5, "Your post reached 5 likes"], [10, "Your post reached 10 likes"], [25, "Your post reached 25 likes"]]) eq(`like milestone ${m}`, one(row({ type: "like", milestone: m })).body, text);
eq("friend request: the sender's name", [one(row({ type: "friend_request", post_id: null })).title, one(row({ type: "friend_request", post_id: null })).body], ["Ana", "sent you a friend request"]);
eq("friend accept", [one(row({ type: "friend_accept", post_id: null })).title, one(row({ type: "friend_accept", post_id: null })).body], ["Ana", "is now your friend"]);
eq("message: sender name + 'sent you a message'", [one(row({ type: "message", post_id: null, last_was_post: false })).title, one(row({ type: "message", post_id: null, last_was_post: false })).body], ["Ana", "sent you a message"]);
eq("message with a shared post: 'sent you a post'", one(row({ type: "message", post_id: null, last_was_post: true })).body, "sent you a post");
eq("a missing or blank name is 'Someone'", [one(row({ actor_name: null })).body, one(row({ actor_name: "   " })).body], ["Someone reacted to your post", "Someone reacted to your post"]);
eq("a very long name is cut", one(row({ type: "friend_request", actor_name: "x".repeat(100) })).title.length, 40);

// ── message text: never unless the database sent it for an adult, never for a minor ──
const msg = (over) => one(row({ type: "message", post_id: null, last_was_post: false, ...over }));
eq("no preview in the row: no text, whoever the person is", [msg({}).body, msg({ preview: null, recipient_minor: true }).body], ["sent you a message", "sent you a message"]);
eq("an adult who turned previews on (the database sent the text): the text", msg({ preview: "see you at 8" }).body, "see you at 8");
eq("a MINOR never gets the text, even if a row carries it", [msg({ preview: "see you at 8", recipient_minor: true }).body, msg({ preview: "see you at 8", recipient_minor: true }).title], ["sent you a message", "Ana"]);
eq("a shared post never shows a text", msg({ preview: "look", last_was_post: true }).body, "sent you a post");
eq("a long preview is cut to 120", msg({ preview: "y".repeat(500) }).body.length, 120);
ok("the data of a push never holds message text", !JSON.stringify(msg({ preview: "SECRET TEXT" }).data).includes("SECRET"));

// ── routes ──
eq("tap targets", [routeFor(row({ type: "message" })), routeFor(row({ type: "friend_request" })), routeFor(row({ type: "friend_accept" })), routeFor(row({ type: "reaction" })), routeFor(row({ type: "like" })), routeFor(row({ type: "verdict_survived" })), routeFor(row({ type: "x", post_id: null }))],
  [`/messages/${U(2)}`, "/people", `/messages/${U(2)}`, `/post/${P(1)}/reaction-tree`, `/post/${P(1)}/reaction-tree`, `/post/${P(1)}/reaction-tree`, "/notifications"]);
ok("every route the server makes is one the app accepts", ["message", "friend_request", "friend_accept", "reaction", "like", "verdict_survived"].every((type) => routeFromPushData({ route: routeFor(row({ type })) }) !== null));
eq("the app opens only known routes", [routeFromPushData({ route: "/evil" }), routeFromPushData({ route: "https://x.test" }), routeFromPushData({ route: 5 }), routeFromPushData(null), routeFromPushData({ route: `/messages/${"z".repeat(36)}` }), routeFromPushData({ route: "/people" }), routeFromPushData({ route: "/".padEnd(200, "a") })], [null, null, null, null, null, "/people", null]);

// ── batching duplicates ──
{
  const rows = [row({ id: "a", actor_name: "Ana" }), row({ id: "b", actor_name: "Ben", created_at: "2026-01-01T00:00:59Z" }), row({ id: "c", actor_name: "Ana", created_at: "2026-01-01T00:01:00Z" })];
  const out = buildPushes(rows);
  eq("three reactions to one post -> one push, all three rows", [out.length, out[0].ids.sort(), out[0].body], [1, ["a", "b", "c"], "Ana and 1 other reacted to your post"]);
  const out3 = buildPushes([...rows, row({ id: "d", actor_name: "Cy", created_at: "2026-01-01T00:02:00Z" })]);
  eq("...'and 2 others'", out3[0].body, "Ana and 2 others reacted to your post");
  eq("reactions to different posts, or for different people, stay apart", buildPushes([row({ id: "a" }), row({ id: "b", post_id: P(2) }), row({ id: "c", recipient_id: U(9) })]).length, 3);
  const msgs = buildPushes([row({ id: "m1", type: "message", post_id: null, last_was_post: false }), row({ id: "m2", type: "message", post_id: null, last_was_post: true })]);
  eq("two message rows from one friend -> one push (the newest decides post / message)", [msgs.length, msgs[0].ids, msgs[0].body], [1, ["m1", "m2"], "sent you a post"]);
  eq("messages from two friends are two pushes", buildPushes([row({ id: "m1", type: "message", actor_id: U(2) }), row({ id: "m2", type: "message", actor_id: U(3) })]).length, 2);
  eq("two likes rows of one post (a milestone and its repeat) -> one push", buildPushes([row({ id: "l1", type: "like", milestone: 5 }), row({ id: "l2", type: "like", milestone: 5 })]).map((p) => p.ids.length), [2]);
  eq("friend requests from different people are separate", buildPushes([row({ id: "f1", type: "friend_request", actor_id: U(2) }), row({ id: "f2", type: "friend_request", actor_id: U(3) })]).length, 2);
  eq("a row with no token makes no push (the database already marks those skipped)", buildPushes([row({ tokens: [] })]), []);
  eq("two phones of one person: one push, two messages", (() => { const p = buildPushes([row({ tokens: [TOKEN(1), TOKEN(2)] })]); return [p.length, toExpoMessages(p).map((m) => m.message.to)]; })(), [1, [TOKEN(1), TOKEN(2)]]);
}

// ── Expo messages and chunks ──
{
  const m = toExpoMessages(buildPushes([row()]))[0].message;
  eq("an Expo message: token, text, data, sound, priority, ttl", [m.to, m.title, m.body, m.sound, m.priority, m.ttl, m.data.route], [TOKEN(1), "Tryal", "Ana reacted to your post", "default", "high", 86400, `/post/${P(1)}/reaction-tree`]);
  eq("at most 100 per request", chunk(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length), [100, 100, 50]);
  eq("no messages, no chunks", chunk([]), []);
}

// ── Expo's answers: tickets ──
{
  const pushes = [
    ...buildPushes([row({ id: "a", post_id: P(1), tokens: [TOKEN(1)] })]),
    ...buildPushes([row({ id: "b", post_id: P(2), tokens: [TOKEN(2)] })]),
    ...buildPushes([row({ id: "c", post_id: P(3), tokens: [TOKEN(3), TOKEN(4)] })]),
  ];
  const msgs = toExpoMessages(pushes);       // a:t1, b:t2, c:t3, c:t4
  const out = interpretTickets(msgs, [{ status: "ok", id: "T1" }, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }, { status: "ok", id: "T3" }, { status: "error", details: { error: "DeviceNotRegistered" } }]);
  eq("ok -> sent, and the ticket is kept for its receipt", [out.sent.sort(), out.tickets], [["a", "c"], [{ id: "T1", token: TOKEN(1) }, { id: "T3", token: TOKEN(3) }]]);
  eq("DeviceNotRegistered -> the token is removed; a push whose only token is dead is skipped, not retried", [out.removeTokens.sort(), out.skipped, out.retry], [[TOKEN(2), TOKEN(4)], ["b"], []]);
  const rate = interpretTickets(msgs.slice(0, 1), [{ status: "error", message: "slow down", details: { error: "MessageRateExceeded" } }]);
  eq("a rate limit is retried, with Expo's reason", [rate.sent, rate.retry, rate.removeTokens], [[], [{ ids: ["a"], error: "MessageRateExceeded" }], []]);
  const down = interpretTickets(msgs, null, "Expo HTTP 503");
  eq("the whole request failing (network, 5xx): everything is retried, nothing is dropped", [down.sent, down.retry.map((r) => r.ids).flat().sort(), down.retry[0].error, down.removeTokens], [[], ["a", "b", "c"], "Expo HTTP 503", []]);
  const short = interpretTickets(msgs, [{ status: "ok", id: "T1" }]);
  eq("fewer tickets than messages: the missing ones are retried", [short.sent, short.retry.map((r) => r.ids).flat().sort()], [["a"], ["b", "c"]]);
  eq("a push is sent when ANY of its tokens took it", interpretTickets(msgs.slice(2), [{ status: "error", details: { error: "MessageRateExceeded" } }, { status: "ok", id: "T9" }]).sent, ["c"]);
}

// ── receipts ──
{
  const tickets = [{ ticket_id: "T1", token: TOKEN(1) }, { ticket_id: "T2", token: TOKEN(2) }, { ticket_id: "T3", token: TOKEN(3) }, { ticket_id: "T4", token: TOKEN(2) }];
  const r = interpretReceipts(tickets, { T1: { status: "ok" }, T2: { status: "error", details: { error: "DeviceNotRegistered" } }, T4: { status: "error", details: { error: "DeviceNotRegistered" } } });
  eq("receipts: DeviceNotRegistered removes the token (once); a missing receipt stays for next time", [r.removeTokens, r.finished.sort()], [[TOKEN(2)], ["T1", "T2", "T4"]]);
  eq("other receipt errors finish the ticket but remove nothing", interpretReceipts([{ ticket_id: "T9", token: TOKEN(9) }], { T9: { status: "error", details: { error: "MessageTooBig" } } }), { removeTokens: [], finished: ["T9"] });
}

// ── settings and tokens ──
eq("defaults: everything on except message text", DEFAULT_PUSH_PREFS, { enabled: true, survived: true, reactions: true, likes: true, friends: true, messages: true, message_preview: false });
eq("a partial / odd server answer becomes full prefs", [normalizePrefs({ likes: false }).likes, normalizePrefs({ likes: false }).messages, normalizePrefs(null).message_preview, normalizePrefs({ likes: "no" }).likes], [false, true, false, true]);
eq("the settings screen has a switch for each kind", PUSH_PREF_ROWS.map((r) => r.key), ["survived", "reactions", "likes", "friends", "messages", "message_preview"]);
ok("Expo token shape", EXPO_TOKEN_RE.test("ExponentPushToken[abc_DEF-123]") && EXPO_TOKEN_RE.test("ExpoPushToken[abc]") && !EXPO_TOKEN_RE.test("abc") && !EXPO_TOKEN_RE.test("ExpoPushToken[]") && !EXPO_TOKEN_RE.test("ExpoPushToken[a b]"));

// ── the app registers and removes its token; the function is deployed and scheduled ──
{
  const push = read("../lib/push.ts"), layout = read("../app/_layout.tsx"), auth = read("../providers/AuthProvider.tsx");
  ok("on sign-in the app asks (once per account) and saves the Expo push token", /registerForPush\(id\)/.test(layout) && /requestPermissionsAsync\(\)/.test(push) && /getExpoPushTokenAsync/.test(push) && /register_push_token/.test(push) && /askedKey\(userId\)/.test(push));
  ok("it is registered only for a signed-in person, not on the auth screens", /if \(!id \|\| segments\[0\] === "\(auth\)"\) return;[\s\S]{0,400}registerForPush\(id\)/.test(layout));
  ok("a rotated token is saved again", /addPushTokenListener/.test(push) && /watchPushToken\(\)/.test(layout));
  ok("signing out (and deleting the account) removes this phone's token first", (auth.match(/await unregisterPush\(\)/g) ?? []).length === 2 && /remove_push_token/.test(push));
  ok("nothing here can break sign-in: expo-notifications is loaded lazily and every call is guarded", /require\("expo-notifications"\)/.test(push) && !/^import .* from "expo-notifications"/m.test(push) && (push.match(/catch/g) ?? []).length >= 6);
  ok("a tap opens only a known route", /routeFromPushData\(response\.notification\.request\.content\.data\)/.test(push));
  ok("the settings screen reads and writes the prefs through the server", /getPushPrefs\(\)/.test(read("../app/settings/notifications.tsx")) && /set_push_prefs/.test(push) && /"\/settings\/notifications"/.test(read("../app/settings.tsx")));
  const fns = read("../supabase/FUNCTIONS.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  ok("send-push is listed for ship.sh with its schedule, no gateway JWT check", fns.some((l) => /^send-push\s+schedule=supabase\/schedule-send-push\.sql\s+--no-verify-jwt/.test(l)));
  const sched = read("../supabase/schedule-send-push.sql");
  ok("pg_cron calls it every minute with the service key from Vault", /'send-push',\s*'\* \* \* \* \*'/.test(sched) && /send-push\?run=1/.test(sched) && /service_role_key/.test(sched));
  const fn = read("../supabase/functions/send-push/index.ts");
  ok("only a service-level key may call it; a plain call is a dry run", /return new Response\("forbidden", \{ status: 403 \}\)/.test(fn) && /dryRun: true/.test(fn));
  ok("it retries, removes dead tokens (tickets and receipts) and records each result", /push_mark_retry/.test(fn) && /push_remove_tokens/.test(fn) && /push_due_tickets/.test(fn) && /getReceipts/.test(fn) && /push_mark_sent/.test(fn) && /chunk\(messages, 100\)/.test(fn));
  const order = read("../supabase/MIGRATIONS_ORDER.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  eq("migration-push.sql runs after friends and before known-connections (which stays last)", order.slice(-3), ["migration-friends-messages.sql", "migration-push.sql", "migration-known-connections.sql"]);
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
