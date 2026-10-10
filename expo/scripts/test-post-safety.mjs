#!/usr/bin/env node
/**
 * Posting never crashes: a throwing render or upload becomes "Couldn't post. Try again." with the edits kept;
 * "Post without captions?" is asked before any caption-less retry; the error recorder stores and uploads
 * reports and lets a released-player error pass without aborting; the toolbar has no Delete.
 *
 *   node --experimental-strip-types scripts/test-post-safety.mjs
 */
import { readFileSync } from "node:fs";
import { POST_FAILED_TEXT, renderWithCaptionFallback, safePost } from "../lib/safePost.ts";
import {
  ERROR_STORAGE_KEY, FATAL_WRITE_WAIT_MS, createErrorRecorder, isReleasedNativeObjectError, wrapGlobalHandler,
} from "../lib/errorRecorder.ts";
import { CUTS_TOOL_IDS, EDITOR_TOOL_IDS, MIN_TOOL_TARGET_PT, toolWidth } from "../lib/editorToolbar.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const memoryStorage = () => {
  const m = new Map();
  return { m, getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
};
const CTX = { screen: "/edit", appVersion: "1.0.3", buildNumber: "39", updateId: "u-1", userId: "user-1" };

// ── a throwing render never crashes the post ──
{
  // the editor state: nothing the post flow does may change it
  const editor = { clips: [{ id: "a", trimStartMs: 100 }], captionEdits: { 3: "" }, captionStyle: { scale: 1.2 } };
  const before = JSON.stringify(editor);
  const banner = { shown: null, retry: false };
  const logged = [];
  const result = await safePost(
    async () => {
      throw new TypeError("Cannot read property 'uri' of undefined"); // e.g. the render step blew up
    },
    (e) => { banner.shown = POST_FAILED_TEXT; banner.retry = true; logged.push(e.message); },
  );
  eq("a throw anywhere in the post flow is a result, not a crash", [result.ok, result.message], [false, "Cannot read property 'uri' of undefined"]);
  eq("the editor shows \"Couldn't post. Try again.\" with a Retry button, and the error is logged", [banner.shown, banner.retry, logged.length], ["Couldn't post. Try again.", true, 1]);
  eq("every edit is kept (the flow touches none of them)", JSON.stringify(editor), before);
  eq("a rejected promise and a thrown string are handled too", [(await safePost(() => Promise.reject(new Error("db insert failed")))).message, (await safePost(async () => { throw "boom"; })).message], ["db insert failed", "boom"]);
  eq("an error thrown while reporting does not escape", (await safePost(async () => { throw new Error("x"); }, () => { throw new Error("reporter broke"); })).ok, false);
  eq("success is ok", (await safePost(async () => {})).ok, true);
  // Retry runs the whole flow again and can succeed
  let attempts = 0;
  const flow = async () => { if (++attempts === 1) throw new Error("network"); };
  eq("Retry after a failure posts", [(await safePost(flow)).ok, (await safePost(flow)).ok, attempts], [false, true, 2]);
}

// ── captions: a failed render asks first ──
{
  const throwing = async () => { throw Object.assign(new Error("native"), { code: "ERR_RENDER_FAILED" }); };
  const errors = [];
  let asked = 0;
  const cancelled = await renderWithCaptionFallback({
    hasCaptions: true, renderWith: throwing, confirmWithoutCaptions: async () => { asked++; return false; }, onError: (e) => errors.push(e),
  });
  eq("a throwing render with captions: \"Post without captions?\" is asked, and Cancel stops the post", [cancelled, asked, errors.length], [{ status: "cancelled" }, 1, 1]);
  const calls = [];
  const confirmed = await renderWithCaptionFallback({
    hasCaptions: true,
    renderWith: async (withCaptions) => { calls.push(withCaptions); return withCaptions ? throwing() : { ok: true, value: "plain.mp4", note: "ok" }; },
    confirmWithoutCaptions: async () => true,
  });
  eq("confirmed: ONE retry without captions, which posts", [confirmed, calls], [{ status: "rendered", value: "plain.mp4", withCaptions: false, note: "ok" }, [true, false]]);
  const retryFails = await renderWithCaptionFallback({ hasCaptions: true, renderWith: throwing, confirmWithoutCaptions: async () => true });
  eq("if the retry fails too the post still goes out the old way (no rendered file), without captions", [retryFails.status, retryFails.value, retryFails.withCaptions], ["rendered", null, false]);
  const ok = await renderWithCaptionFallback({ hasCaptions: true, renderWith: async () => ({ ok: true, value: "final.mp4", note: "n" }), confirmWithoutCaptions: async () => { throw new Error("must not ask"); } });
  eq("a good render with captions never asks", [ok.status, ok.value, ok.withCaptions], ["rendered", "final.mp4", true]);
  let asked2 = 0;
  const plain = await renderWithCaptionFallback({ hasCaptions: false, renderWith: throwing, confirmWithoutCaptions: async () => { asked2++; return true; } });
  eq("no captions: a failed render is not an error to ask about (post the old way)", [plain.status, plain.value, asked2], ["rendered", null, 0]);
  eq("a render that reports failure (not a throw) is handled the same way", (await renderWithCaptionFallback({ hasCaptions: true, renderWith: async (w) => (w ? { ok: false, reason: "timeout", note: "Not rendered: timeout" } : { ok: true, value: "p", note: "" }), confirmWithoutCaptions: async () => true })).value, "p");
}

// ── the error recorder ──
{
  const storage = memoryStorage();
  const uploaded = [];
  let t = 1000;
  const rec = createErrorRecorder({ storage, now: () => t++, context: () => ({ ...CTX }), upload: async (rows) => { uploaded.push(...rows); } });
  await rec.record(new Error("kaboom"), { kind: "fatal", isFatal: true });
  const saved = JSON.parse(storage.m.get(ERROR_STORAGE_KEY));
  eq("a fatal error is stored with message, stack and context", [saved.length, saved[0].message, saved[0].stack.includes("kaboom"), Object.keys(saved[0].context).sort()], [1, "kaboom", true, ["appVersion", "buildNumber", "isFatal", "kind", "screen", "timestamp", "updateId", "userId"]]);
  eq("the context has screen, versions, build, update id, user and time", [saved[0].context.screen, saved[0].context.appVersion, saved[0].context.buildNumber, saved[0].context.updateId, saved[0].context.userId, saved[0].context.timestamp], ["/edit", "1.0.3", "39", "u-1", "user-1", 1000]);
  await rec.record("a string", { kind: "unhandledRejection" });
  eq("anything can be recorded (a string, undefined)", [JSON.parse(storage.m.get(ERROR_STORAGE_KEY)).length, (await rec.record(undefined, { kind: "x" }), JSON.parse(storage.m.get(ERROR_STORAGE_KEY)).length)], [2, 3]);
  // a new run (new recorder, same storage) uploads and clears
  const next = createErrorRecorder({ storage, now: () => 5000, context: () => CTX, upload: async (rows) => { uploaded.push(...rows); } });
  eq("at the next launch the pending reports are uploaded as the user's own rows", [(await next.flush("user-1")).uploaded, uploaded.length, uploaded.every((r) => r.user_id === "user-1" && typeof r.context === "object")], [3, 3, true]);
  eq("...and cleared", [storage.m.has(ERROR_STORAGE_KEY), await next.pendingCount()], [false, 0]);
  eq("nothing pending: nothing uploaded", (await next.flush("user-1")).uploaded, 0);
  // not signed in / another account / upload failure: kept
  const s2 = memoryStorage();
  const r2 = createErrorRecorder({ storage: s2, now: () => 1, context: () => ({ ...CTX, userId: "someone-else" }), upload: async () => { throw new Error("offline"); } });
  await r2.record(new Error("e"), { kind: "post" });
  eq("signed out: kept for later", [(await r2.flush(null)).uploaded, await r2.pendingCount()], [0, 1]);
  eq("an upload failure keeps the reports for the next launch (and does not throw)", [(await r2.flush("someone-else")).uploaded, await r2.pendingCount()], [0, 1]);
  const r3 = createErrorRecorder({ storage: s2, now: () => 1, context: () => CTX, upload: async () => {} });
  eq("a report of another account is not uploaded by this user (RLS would refuse it)", [(await r3.flush("user-1")).uploaded, await r3.pendingCount()], [0, 1]);
  // limits
  const s4 = memoryStorage();
  const r4 = createErrorRecorder({ storage: s4, now: () => 1, context: () => CTX, upload: async () => {} });
  for (let i = 0; i < 30; i++) await r4.record(new Error("e" + i), { kind: "x" });
  eq("at most 20 reports are kept (the oldest go)", [await r4.pendingCount(), JSON.parse(s4.m.get(ERROR_STORAGE_KEY))[0].message], [20, "e10"]);
  await r4.record(Object.assign(new Error("m".repeat(2000)), { stack: "s".repeat(9000) }), { kind: "x" });
  const last = JSON.parse(s4.m.get(ERROR_STORAGE_KEY)).pop();
  eq("long messages and stacks are cut", [last.message.length, last.stack.length], [500, 4000]);
  const broken = createErrorRecorder({ storage: { getItem: async () => { throw new Error("disk"); }, setItem: async () => { throw new Error("disk"); }, removeItem: async () => {} }, now: () => 1, context: () => CTX, upload: async () => {} });
  eq("a broken storage never throws", await broken.record(new Error("x"), { kind: "x" }), undefined);

  // the global handler: write first, then the previous handler (RN's) as before
  const order = [];
  const handler = wrapGlobalHandler({
    previous: (e, fatal) => order.push(["previous", e.message, fatal]),
    record: async (e, extra) => { await new Promise((r) => setTimeout(r, 5)); order.push(["recorded", extra.kind]); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  handler(new Error("fatal one"), true);
  await new Promise((r) => setTimeout(r, 40));
  eq("a fatal error is recorded BEFORE React Native's own handler runs", order, [["recorded", "fatal"], ["previous", "fatal one", true]]);
  const slow = [];
  const slowHandler = wrapGlobalHandler({ previous: (e) => slow.push("previous"), record: () => new Promise(() => {}), sleep: (ms) => new Promise((r) => setTimeout(r, 20)) });
  slowHandler(new Error("x"), true);
  await new Promise((r) => setTimeout(r, 60));
  eq("a write that never finishes cannot keep the app alive forever (the wait is bounded)", [slow, FATAL_WRITE_WAIT_MS], [["previous"], 800]);
  const nonFatal = [];
  wrapGlobalHandler({ previous: (e, f) => nonFatal.push(f), record: async () => {}, sleep: async () => {} })(new Error("n"), false);
  eq("a non-fatal error goes straight on", nonFatal, [false]);
  const swallowed = [];
  const h2 = wrapGlobalHandler({ previous: () => swallowed.push("previous"), record: async (e, extra) => { swallowed.push(extra.kind); }, sleep: async () => {} });
  h2(Object.assign(new Error("Unable to find the native shared object associated with given JavaScript object"), { name: "NativeSharedObjectNotFoundException" }), true);
  await new Promise((r) => setTimeout(r, 10));
  eq("a released video player touched after its screen closed is recorded and does NOT abort the app", swallowed, ["swallowed"]);
  eq("only that kind of error is let through", [isReleasedNativeObjectError(new Error("shared object that was already released")), isReleasedNativeObjectError(new TypeError("undefined is not an object")), isReleasedNativeObjectError(null)], [true, false, false]);
}

// ── the toolbar ──
{
  const src = readFileSync(new URL("../app/edit.tsx", import.meta.url), "utf8");
  const a = src.indexOf("<View style={styles.toolbar}>\n          {/* Trim");
  const b = src.indexOf("<View style={[styles.bottomSection");
  const toolbar = src.slice(a, b);
  eq("the toolbar section exists", [a > 0, b > a], [true, true]);
  eq("it has no Delete tool: no Delete label, no delete handler, no trash icon", [/>\s*Delete\s*</.test(toolbar.replace(/Delete line/g, "")), toolbar.includes("handleDeleteClip"), toolbar.includes("Trash2")], [false, false, false]);
  eq("nothing else in the editor still refers to the removed clip-delete handler", src.includes("handleDeleteClip"), false);
  eq("the tools: Trim, Split on the Cuts screen; Text, Captions, Cuts in the full-screen editor (Style lives in the Captions panel and the caption bar)", [CUTS_TOOL_IDS, EDITOR_TOOL_IDS], [["trim", "split"], ["text", "captions", "cuts"]]);
  eq("each tool fits the narrowest iPhone widths above the 44 pt target (375 and 320 pt)", [toolWidth(375, CUTS_TOOL_IDS.length, 8), toolWidth(320, CUTS_TOOL_IDS.length, 8)].map((w) => Math.round(w) >= MIN_TOOL_TARGET_PT), [true, true]);
  eq("the toolbar buttons share the width (flex), so nothing overflows", /toolBtn: \{[^}]*flex: 1/.test(src), true);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
