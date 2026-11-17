#!/usr/bin/env node
/**
 * Money campaign form rules, the owed-amount math and the card labels (lib/moneyCampaign.ts). The cases are the ones the database tests use
 * (test-money-board-sql.mjs), so what a person is told on the form and what the server accepts cannot drift apart.
 *   node --experimental-strip-types --no-warnings scripts/test-money-campaign.mjs
 */
import {
  EMPTY_FORM, cardModel, deadlineLabel, dollars, footageHostOk, fullVideoLinkOk, handleOk, videoLinkPlatform, withHttps, PAY_PRESETS, DEFAULT_PLATFORMS, moneyErrorMessage, owedFor, parseMoney, profileBadge, recordLabel, ratingLabel, sortCampaigns, validateCampaign, workedExample,
} from "../lib/moneyCampaign.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const NOW = new Date("2026-11-14T12:00:00Z");
const GOOD = { ...EMPTY_FORM, title: "Clip my podcast", description: "Funny moments, no spoilers", ratePer1k: "1.50", capPerClip: "20", totalBudget: "200", guaranteedPerClip: "3", platforms: ["tiktok", "instagram"], paymentMethod: "paypal", paymentHandle: "pay@example.com", maxClips: "2", agree: true };
const IDS = ["11111111-1111-1111-1111-111111111111"];
const ok = (o, ids = IDS) => validateCampaign({ ...GOOD, ...o }, NOW, ids).ok;

// ── footage and handle: the same cases as the database tests ──
import { GOOD as LINK_GOOD, BAD as LINK_BAD, BARE as LINK_BARE } from "./post-link-cases.mjs";
eq("full video link: the same accepted addresses and platforms as the database (shared case file)", LINK_GOOD.map(([u]) => videoLinkPlatform(u)), LINK_GOOD.map(([, p]) => p));
eq("full video link: every refused address is refused (look-alikes, http, user@host, ports, spaces, other sites)", LINK_BAD.map((u) => fullVideoLinkOk(u)), LINK_BAD.map(() => false));
eq("full video link: a bare address gets https:// first, as in the post composer", LINK_BARE.map(([u]) => videoLinkPlatform(withHttps(u))), LINK_BARE.map(([, p]) => p));
eq("full video link: the form takes it empty, with a good link, and refuses a Drive link", [ok({ fullVideoUrl: "" }), ok({ fullVideoUrl: "youtube.com/watch?v=1" }), ok({ fullVideoUrl: "https://drive.google.com/x" })], [true, true, false]);
eq("a campaign needs an uploaded video OR a Drive / Dropbox link, sends the video ids, and the link is null when empty", [ok({}, []), ok({ footageUrl: "https://drive.google.com/drive/folders/abc" }, []), (() => { const r = validateCampaign(GOOD, NOW, IDS); return r.ok ? [r.args.p_footage_ids, r.args.p_footage_url, r.args.p_full_video_url] : null; })()], [false, true, [IDS, null, null]]);
eq("the Drive / Dropbox link: Drive and Dropbox pass (a bare address gets https://); other hosts, look-alikes, user@host tricks, http and YouTube fail", [["https://drive.google.com/drive/folders/abc", "https://www.dropbox.com/sh/abc/xyz?dl=0", "https://dropbox.com/s/abc/file"].map(footageHostOk), ["https://evil.com/drive.google.com", "https://drive.google.com.evil.com/x", "https://drive.google.com@evil.com/x", "http://drive.google.com/x", "https://www.youtube.com/watch?v=1", "https://notdropbox.com/x", ""].map(footageHostOk), [ok({ footageUrl: "drive.google.com/x" }), ok({ footageUrl: "https://evil.com/x" }), ok({ footageUrl: "https://www.youtube.com/watch?v=1" })]], [[true, true, true], Array(7).fill(false), [true, false, false]]);
eq("the link can be sent with videos, and its sent value is the https form", (() => { const r = validateCampaign({ ...GOOD, footageUrl: "drive.google.com/x" }, NOW, IDS); return r.ok ? r.args.p_footage_url : null; })(), "https://drive.google.com/x");
eq("the Pay presets are $1, $2 and $3 per 1,000 views; the defaults (platforms, 7 day window, 14 day deadline, 1000 views, 5 clips) are set so most creators never open More options", [[...PAY_PRESETS], EMPTY_FORM.platforms, EMPTY_FORM.viewWindowDays, EMPTY_FORM.deadlineDays, EMPTY_FORM.minViews, EMPTY_FORM.maxClips, DEFAULT_PLATFORMS === EMPTY_FORM.platforms], [[1, 2, 3], ["tiktok", "instagram", "youtube"], 7, 14, "1000", "5", false]);
eq("handle: an email, @name and $cashtag pass", ["@some-user_1", "$cashtag", "name.surname+tips@mail.example.com", "pay@example.com"].map(handleOk), Array(4).fill(true));
eq("handle: links, deep links, bare payment domains, spaces and one character fail", ["https://paypal.me/someone", "venmo://paycharge?txn=pay", "paypal.me", "cash.app/$name", "my handle", "http://x.co", "a", "www.pay.com", "$$"].map(handleOk), Array(9).fill(false));

// ── the form ──
eq("a good form is accepted and becomes the RPC arguments", (() => { const r = validateCampaign(GOOD, NOW, IDS); return r.ok ? [r.args.p_rate_per_1k, r.args.p_cap_per_clip, r.args.p_total_budget, r.args.p_guaranteed_per_clip, r.args.p_platforms, r.args.p_view_window_days, r.args.p_min_views, r.args.p_payment_method, r.args.p_deadline, r.args.p_max_clips_per_clipper, r.args.p_agree] : null; })(), [1.5, 20, 200, 3, ["tiktok", "instagram"], 7, 1000, "paypal", "2026-11-28T12:00:00.000Z", 2, true]);
const cases = [
  ["a title over 60 characters", { title: "x".repeat(61) }], ["an empty title", { title: "  " }], ["a description over 1000 characters", { description: "y".repeat(1001) }], ["no description", { description: "" }],
  ["a Drive link as the full video link", { fullVideoUrl: "https://drive.google.com/x" }],
  ["rate 0", { ratePer1k: "0" }], ["rate not a number", { ratePer1k: "abc" }], ["rate over 1000", { ratePer1k: "1001" }], ["negative cap", { capPerClip: "-1" }], ["budget 0", { totalBudget: "0" }],
  ["a budget smaller than one clip's maximum (cap + guarantee)", { totalBudget: "22", capPerClip: "20", guaranteedPerClip: "3" }], ["a negative guarantee", { guaranteedPerClip: "-1" }], ["three decimals", { ratePer1k: "1.505" }],
  ["no platforms", { platforms: [] }], ["a view window of 2 or 15 days", { viewWindowDays: 2 }], ["a view window of 15 days", { viewWindowDays: 15 }], ["negative min views", { minViews: "-1" }], ["min views not whole", { minViews: "1.5" }],
  ["no payment method", { paymentMethod: null }], ["a link as the handle", { paymentHandle: "https://paypal.me/x" }], ["no handle", { paymentHandle: "" }],
  ["max clips 0", { maxClips: "0" }], ["max clips 51", { maxClips: "51" }], ["the agreement not accepted", { agree: false }],
];
for (const [label, o] of cases) eq(`refused: ${label}`, ok(o), false);
eq("accepted: no guarantee (empty or 0), a $ in front of an amount, 3 and 14 day windows, all four platforms", [ok({ guaranteedPerClip: "" }), ok({ guaranteedPerClip: "0" }), ok({ ratePer1k: "$1.50" }), ok({ viewWindowDays: 3 }), ok({ viewWindowDays: 14 }), ok({ platforms: ["tiktok", "instagram", "youtube", "x"] })], Array(6).fill(true));
eq("every error names its field (title, footage, handle ...)", (() => { const r = validateCampaign({ ...EMPTY_FORM }, NOW); return r.ok ? [] : Object.keys(r.errors).sort(); })(), ["agree", "capPerClip", "description", "footage", "paymentHandle", "paymentMethod", "ratePer1k", "title", "totalBudget"]);
eq("the deadline is 'days from now' in UTC", (() => { const r = validateCampaign({ ...GOOD, deadlineDays: 30 }, NOW, IDS); return r.ok ? r.args.p_deadline : null; })(), "2026-12-14T12:00:00.000Z");
eq("money parsing", [parseMoney("12"), parseMoney("12.5"), parseMoney("$12.50"), parseMoney("12.505"), parseMoney("-3"), parseMoney(""), parseMoney("1e3")], [12, 12.5, 12.5, null, null, null, null]);

// ── the owed amount: the same cases as the database tests (rate 1.50, cap 20, guarantee 3, min views 1000) ──
const C = { ratePer1k: 1.5, capPerClip: 20, guaranteedPerClip: 3, minViews: 1000 };
eq("owed: 999 views = the guarantee; 1000 = 4.50; 10,000 = 18.00 (the spec's example 15 + 3); 100,000 = capped 23.00; 1,234 = 4.85; 1,250 = 4.88; 0 = 3.00", [999, 1000, 10000, 100000, 1234, 1250, 0].map((v) => owedFor(v, C)), [3, 4.5, 18, 23, 4.85, 4.88, 3]);
eq("the worked example on the form is what one clip with 10,000 views earns (the spec: $2 per 1,000 + $3 guaranteed = $23)", [workedExample({ ...EMPTY_FORM, ratePer1k: "2", guaranteedPerClip: "3" }), workedExample({ ...EMPTY_FORM, ratePer1k: "1.50" }), workedExample({ ...EMPTY_FORM, ratePer1k: "1.50", capPerClip: "10" }), workedExample({ ...EMPTY_FORM, ratePer1k: "3", capPerClip: "20", guaranteedPerClip: "3" }), workedExample({ ...EMPTY_FORM })], ["10,000 views = $23 per clip", "10,000 views = $15 per clip", "10,000 views = $10 per clip (the most it can earn)", "10,000 views = $23 per clip (the most it can earn)", null]);
eq("dollars", [dollars(15), dollars(1.5), dollars(0.1 + 0.2 + 0)], ["$15", "$1.50", "$0.30"]);

// ── cards ──
const row = (o) => ({ id: "c1", creator_id: "u1", title: "Clip my podcast", description: "d", full_video_url: null, rate_per_1k: "1.50", cap_per_clip: "20.00", total_budget: "200.00", guaranteed_per_clip: "3.00", platforms: ["instagram", "tiktok"], view_window_days: 7, min_views: 1000, payment_method: "paypal", deadline: "2026-11-17T16:00:00Z", max_clips_per_clipper: 5, status: "open", terms_frozen_at: null, budget_committed: "40.00", budget_left: "160.00", created_at: "2026-11-10T00:00:00Z", ...o });
const stats = { rating_avg: 4.8, rating_count: 23, approved_count: 14, paid_count: 14, avg_days_to_pay: 1.2, late_count: 0 };
eq("a card shows rate, cap, guarantee, live budget left, platforms, 'Pays via', rating, payment record and a countdown", cardModel(row(), stats, NOW), { id: "c1", title: "Clip my podcast", rate: "$1.50 per 1,000 views", cap: "up to $20 per clip", guarantee: "$3 guaranteed per clip", budgetLeft: "$160 left of $200", platforms: "Instagram · TikTok", payVia: "Pays via PayPal", rating: "★ 4.8 (23)", record: "Paid 14 of 14 · avg 1.2 days", deadline: "Closes in 3 d 4 h" });
eq("no guarantee: no line; no reviews and no payments yet say so", [cardModel(row({ guaranteed_per_clip: "0.00" }), null, NOW).guarantee, ratingLabel(null), recordLabel(null), recordLabel({ ...stats, approved_count: 0, paid_count: 0 })], [null, "No reviews yet", "No payments yet", "No payments yet"]);
eq("the profile badge is '★ 4.8 (23) · Paid 14/14'", [profileBadge(stats), profileBadge(null)], ["★ 4.8 (23) · Paid 14/14", "★ new · Paid 0/0"]);
eq("Venmo and Cash App read as plain text too", [cardModel(row({ payment_method: "venmo" }), null, NOW).payVia, cardModel(row({ payment_method: "cashapp" }), null, NOW).payVia], ["Pays via Venmo", "Pays via Cash App"]);
eq("countdown: hours, closed", [deadlineLabel("2026-11-14T15:30:00Z", NOW), deadlineLabel("2026-11-14T11:00:00Z", NOW)], ["Closes in 3 h", "Closed"]);
const items = [{ row: row({ id: "a", rate_per_1k: "1.00", created_at: "2026-11-01T00:00:00Z" }), stats: { ...stats, rating_avg: 3.0, rating_count: 5 } }, { row: row({ id: "b", rate_per_1k: "2.50", created_at: "2026-11-03T00:00:00Z" }), stats: null }, { row: row({ id: "c", rate_per_1k: "1.50", created_at: "2026-11-02T00:00:00Z" }), stats: { ...stats, rating_avg: 4.9, rating_count: 40 } }];
eq("sort: newest, highest rate, best rated (unrated last)", ["newest", "rate", "rating"].map((k) => sortCampaigns(items, k).map((i) => i.row.id).join("")), ["bca", "bca", "cab"]);

// ── the server's refusals, in plain words ──
eq("server errors become plain sentences", [moneyErrorMessage("This contains words that are not allowed on Tryal."), moneyErrorMessage("you have an overdue payment: resolve it before posting a new campaign"), moneyErrorMessage("this campaign is not open"), moneyErrorMessage("boom"), moneyErrorMessage(null)],
  ["This contains words that are not allowed on Tryal.", "You have an overdue payment. Resolve it before posting a new campaign.", "This campaign is no longer open.", "Something went wrong. Check your connection and try again.", "Something went wrong. Check your connection and try again."]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
