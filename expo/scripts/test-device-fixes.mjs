#!/usr/bin/env node
/**
 * From the device: the native-looking caption default (smaller, normal case, lower, rounded; ALL CAPS an option),
 * pinch that persists, a camera-roll save that works or falls back, and errors that reach client_errors at once.
 *
 *   node --experimental-strip-types scripts/test-device-fixes.mjs
 */
import { readFileSync } from "node:fs";
import { applyCaptionStyle, resolveOverlayStyle, toRenderJson } from "../lib/editStyles.ts";
import { TEXT_LINE_HEIGHT_EM, TEXT_PAD_X_EM, TEXT_PAD_Y_EM, safeZones } from "../lib/feedLayout.ts";
import { defaultCaptionStyle, halfBoxHeight, resetCaptionLook, styledSpec, usableCaptionStyle, withCaptionLook } from "../lib/transcription/captionStyle.ts";
import { buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { resolveCaptionLook } from "../lib/transcription/captionPresets.ts";
import { createGestureTracker, TOUCH_PAD } from "../lib/overlayGestures.ts";
import { createErrorRecorder } from "../lib/errorRecorder.ts";
import { saveToCameraRoll, createSaveStatus, runSaveWithStatus } from "../lib/saveToRoll.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const w = (text, startMs, endMs) => ({ text, startMs, endMs });

// ── 1: the caption default ──
{
  const trial = resolveOverlayStyle("caption", "trial");
  ok("37% smaller than before (60 -> 38)", trial.fontSize === 38 && 1 - 38 / 60 > 0.35 && 1 - 38 / 60 < 0.4);
  ok("normal case by default: the preset has no uppercase", trial.uppercase === undefined);
  eq("lower: 72% from the top", trial.yCenter, 0.72);
  ok("rounded corners (about 0.25 em)", trial.cornerRadius > 0 && Math.abs(trial.cornerRadius - 0.25 * trial.fontSize) < 1);

  const cap = (look, caps) => JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captionLinesToEditOverlays(buildCaptionLines([w("Break my lease", 0, 900)], {}, [{ startMs: 0, endMs: 1000 }], look), look) }, caps)).overlays[0];
  const def = cap(usableCaptionStyle(undefined, true), { supportsFont: true, supportsTextBox: true });
  ok("the render JSON keeps the transcript's casing: no uppercase flag, text as spoken", def.styleSpec.uppercase === undefined && def.text === "Break my lease");
  eq("padding in the export render: 0.5 em across, 0.3 em down, line height 1.25 em", [def.styleSpec.backgroundPaddingX / def.styleSpec.fontSize, def.styleSpec.backgroundPaddingY / def.styleSpec.fontSize, def.styleSpec.lineHeight], [TEXT_PAD_X_EM, TEXT_PAD_Y_EM, TEXT_LINE_HEIGHT_EM]);
  const caps = cap(withCaptionLook(undefined, { uppercase: true }), { supportsFont: true, supportsTextBox: true });
  eq("ALL CAPS is an option: uppercase goes to the render", caps.styleSpec.uppercase, true);
  eq("the preview spec follows the same option", [styledSpec(withCaptionLook(undefined, { uppercase: true })).uppercase, styledSpec(defaultCaptionStyle()).uppercase], [true, undefined]);
  eq("editor, Preview, feed and export draw captions from one function (styledSpec = applyCaptionStyle of the preset)", styledSpec(defaultCaptionStyle()), applyCaptionStyle(resolveOverlayStyle("caption", "trial"), defaultCaptionStyle()));
  eq("Reset to Trial style: normal case again, size and place kept", resetCaptionLook({ scale: 1.4, yCenter: 0.6, xCenter: 0.5, uppercase: true, textColor: "yellow" }), { scale: 1.4, yCenter: 0.6, xCenter: 0.5 });
  eq("Reset on a capable build keeps Classic, normal case", resetCaptionLook({ scale: 1, yCenter: 0.72, xCenter: 0.5, uppercase: true }, true), { scale: 1, yCenter: 0.72, xCenter: 0.5, fontId: "classic" });
  eq("the look knows the option", [resolveCaptionLook({ uppercase: true }).uppercase, resolveCaptionLook({}).uppercase], [true, false]);
  const z = safeZones(195, 422, 390, 47);
  const bottomEdge = 0.72 + halfBoxHeight(1, 16 / 9);
  ok("the default caption box ends above the feed's bottom bar and below the face area", bottomEdge * 422 < z.bottom.y && 0.72 > 0.6);
  const sheet = read("../components/CaptionStyleSheet.tsx");
  ok("the Style sheet has a case option (Aa / AA)", /onChange\(\{ uppercase: c\.value \}\)/.test(sheet) && />Case</.test(sheet));
  ok("editing a caption shows the real casing, not capitals", !/setDraft\([^)]*toUpperCase/.test(read("../components/CaptionPreview.tsx") + read("../components/CaptionsSheet.tsx")));
}

// ── 2: pinch ──
{
  const log = [];
  const t = createGestureTracker({ onEditStart: () => log.push("start"), onCommit: () => log.push("commit") });
  t.begin("pan"); t.begin("pinch"); t.change();
  t.end("pan"); t.end("pinch");
  eq("pan + pinch together: one undo snapshot, one commit", log, ["start", "commit"]);
  log.length = 0;
  t.begin("pan"); t.begin("pinch"); t.change();
  t.end("pan"); // the pan is cancelled by something else: it still ends
  t.end("pinch");
  eq("a cancelled gesture does not strand the others: the pinch still commits", log, ["start", "commit"]);
  log.length = 0;
  t.begin("pinch"); t.change(); t.end("pinch");
  t.begin("pinch"); t.change(); t.end("pinch");
  eq("and the next pinch commits again (the old counter never came back to zero)", log, ["start", "commit", "start", "commit"]);
  log.length = 0;
  t.end("rotate"); t.end("pan");
  eq("a gesture that never began is ignored", [log, t.active()], [[], 0]);
  log.length = 0;
  t.begin("pan"); t.end("pan");
  eq("a tap that moved nothing commits nothing", log, ["start"]);
  ok("the touch area is bigger than the box (two fingers can land on a one-line overlay)", TOUCH_PAD >= 32);
  const drag = read("../components/DraggableTextOverlay.tsx");
  ok("the overlay's gesture view carries that padding with a cancelling margin", /padding: TOUCH_PAD,\s*margin: -TOUCH_PAD/.test(drag));
  ok("pan, pinch and rotation run simultaneously and end through the tracker (not only on success)", /Gesture\.Simultaneous\(/.test(drag) && (drag.match(/onFinalize\(\(\) => tracker\.end/g) ?? []).length === 3);
  ok("pinch does not depend on the overlay being selected", !/isSelected/.test(drag.slice(drag.indexOf("const gesture = useMemo"), drag.indexOf("// ── Animated styles"))));
  ok("a GestureHandlerRootView wraps the whole app", /<GestureHandlerRootView style=\{\{ flex: 1/.test(read("../app/_layout.tsx")));
  ok("the safe-zone guides take no touches", /pointerEvents="none"/.test(read("../components/FeedSafeZones.tsx")));
  ok("the preview frame's overlays come after the tap-to-play and caption layers (on top)", (() => { const e = read("../app/edit.tsx"); return e.indexOf("styles.playOverlay") < e.indexOf("displayOverlays.map"); })());
}

// ── 3a: the recorder ──
{
  const mem = new Map();
  const inserts = [];
  const timers = [];
  const make = (uploadOk) => createErrorRecorder({
    storage: { getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => void mem.set(k, v), removeItem: async (k) => void mem.delete(k) },
    now: () => 1000,
    context: () => ({ screen: "edit", appVersion: "1.0.3", buildNumber: "39", updateId: null, userId: "u1" }),
    upload: async (rows) => { if (!uploadOk()) throw new Error("offline"); inserts.push(rows); },
    schedule: (fn, ms) => void timers.push({ fn, ms }),
    retryDelaysMs: [5, 30],
  });
  let up = true;
  const r = make(() => up);
  await r.reportNow(new Error("Couldn't save"), { kind: "saveToRoll", stage: "save" });
  eq("a caught save failure produces exactly one client_errors insert, at once", [inserts.length, inserts[0].length], [1, 1]);
  const row = inserts[0][0];
  eq("the row matches the RLS policy: user_id is the signed-in user, with message, stack and context", [row.user_id, row.message, row.context.kind, row.context.stage, row.context.userId], ["u1", "Couldn't save", "saveToRoll", "save", "u1"]);
  eq("nothing is left pending after the upload", await r.pendingCount(), 0);
  await r.flush("u1");
  eq("a later flush does not insert it twice", inserts.length, 1);

  // upload fails: kept, retried
  up = false;
  inserts.length = 0;
  await r.reportNow(new Error("again"), { kind: "saveToRoll", stage: "render" });
  eq("an upload that fails keeps the report and schedules a retry", [inserts.length, await r.pendingCount(), timers.length], [0, 1, 1]);
  up = true;
  timers.shift().fn();
  await new Promise((res) => setTimeout(res, 20));
  eq("the retry uploads it (once) and clears it", [inserts.length, await r.pendingCount()], [1, 0]);
  const clientErrors = read("../lib/clientErrors.ts");
  ok("recordClientError uploads at once (reportNow) and the insert has no .select()", /recorder\.reportNow\(error, extra\)/.test(clientErrors) && !/\.insert\(rows\)\.select/.test(clientErrors) && /from\("client_errors"\)\.insert\(rows\)/.test(clientErrors));
  ok("the table's policy is user_id = auth.uid() (the rows carry the signed-in user's id)", /with check \(user_id = auth\.uid\(\)\)/.test(read("../supabase/migration-client-errors.sql")));
  const exp = read("../lib/exportEdit.ts");
  ok("save failures are recorded with the build's capabilities", /recordClientError\(error, \{ kind: "saveToRoll", stage, supportsTextBox/.test(exp));
}

// ── 3b: the save itself ──
{
  const compat = read("../lib/mediaLibraryCompat.ts");
  const sdk = read("../node_modules/expo-media-library/build/legacyWarnings.js");
  ok("the cause: in SDK 57 saveToLibraryAsync from the main module throws on purpose", /export async function saveToLibraryAsync\(localUri\) \{\s*throw errorOnLegacyMethodUse/.test(sdk));
  ok("the fix: save through expo-media-library/legacy, then createAssetAsync, with a file:// uri", /require\("expo-media-library\/legacy"\)/.test(compat) && /legacy\.createAssetAsync/.test(compat) && /file:\/\//.test(compat));
  ok("add-only permission via the same module", /getLegacyMediaLibrary\(\)/.test(read("../lib/exportEdit.ts")) && /requestPermissionsAsync\(true\)/.test(read("../lib/exportEdit.ts")));

  const calls = [];
  const base = (o = {}) => ({
    enabled: true,
    render: async () => (calls.push("render"), { uri: "export.mp4" }),
    ensurePermission: async () => true,
    save: async (u) => void calls.push(`save:${u}`),
    cleanup: async (u) => void calls.push(`cleanup:${u}`),
    ...o,
  });
  let r = await saveToCameraRoll(base({ postedUri: "posted.mp4" }));
  eq("the posted file (cuts + captions) is what is saved: no render at all", [r, calls.includes("render"), calls.includes("save:posted.mp4")], [{ status: "saved" }, false, true]);
  eq("the staged copy is cleaned up after a successful save", calls.includes("cleanup:posted.mp4"), true);
  calls.length = 0;
  r = await saveToCameraRoll(base());
  eq("no posted file (the post went out as source clips): cuts + captions are rendered and saved", [r, calls], [{ status: "saved" }, ["render", "save:export.mp4", "cleanup:export.mp4"]]);
  calls.length = 0;
  r = await saveToCameraRoll(base({ save: async () => { throw new Error("photos said no"); }, postedUri: "posted.mp4" }));
  eq("a failed save keeps the staged copy for Retry", [r.status, calls.includes("cleanup:posted.mp4")], ["failed", false]);
  r = await saveToCameraRoll(base({ render: async () => { throw new Error("x"); } }));
  eq("render fails and there is no posted file: failed, with the reason", [r.status, r.reason], ["failed", "render"]);

  // 3c: the owner sees the real reason
  const mk = () => createSaveStatus();
  const failing = () => saveToCameraRoll(base({ save: async () => { throw new Error("PHPhotosErrorDomain 3302"); } }));
  let s = mk();
  await runSaveWithStatus(s, failing, true);
  eq("owner: the toast carries the real error", s.get().detail, "save: PHPhotosErrorDomain 3302");
  s = mk();
  await runSaveWithStatus(s, failing, false);
  eq("everyone else: no detail", s.get().detail, undefined);
  const toast = read("../components/SaveToRollToast.tsx");
  ok("the toast shows the detail", /state\.detail/.test(toast));
  ok("only the owner account asks for details", /isDebugOwner\(args\.userId\)/.test(read("../lib/exportEdit.ts")));
  ok("Post stages the posted file before the upload can delete it", /stageExportFallback\(rendered\.uri\)/.test(read("../app/edit.tsx")));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
