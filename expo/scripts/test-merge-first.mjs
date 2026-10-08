#!/usr/bin/env node
/**
 * Part A: merge first. Several video clips (camera segments, a camera-roll multi-select) become ONE file before
 * the editor's AI pipeline runs; failures are a message with Retry; no per-segment gallery saves; the picker
 * keeps the picked order and the total-length limit.
 *
 *   node --experimental-strip-types scripts/test-merge-first.mjs
 */
import { readFileSync } from "node:fs";
import { MERGE_FAILED_TEXT, mergeVideoClips, shouldMerge } from "../lib/mergeClips.ts";
import { MAX_IMPORT_VIDEOS, moveItem, removeItem, totalDurationMs, validateSelection } from "../lib/importSelection.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const edit = read("../app/edit.tsx");

const v = (n) => ({ id: `c${n}`, uri: `file:///seg${n}.mov`, type: "video" });
let idSeq = 0;
const newId = () => `m${++idSeq}`;

// ── when to merge ──
{
  eq("two or more videos merge", [shouldMerge([v(1), v(2)], { isDraft: false }), shouldMerge([v(1), v(2), v(3)], { isDraft: false })], [true, true]);
  eq("a single clip does not", shouldMerge([v(1)], { isDraft: false }), false);
  eq("a photo among them does not (no single video to make)", shouldMerge([v(1), { id: "p", uri: "p.jpg", type: "image" }], { isDraft: false }), false);
  eq("a saved draft is already one source: not merged again", shouldMerge([v(1), v(2)], { isDraft: true }), false);
}

// ── the merge ──
{
  const calls = [];
  const render = async (uris, onProgress) => { calls.push(uris); onProgress(0.5); onProgress(2); return { uri: "file:///merged.mp4", durationMs: 12345 }; };
  const progress = [];
  const r = await mergeVideoClips({ clips: [v(1), v(2), v(3)], render, newId, onProgress: (p) => progress.push(p) });
  eq("merge is called once, with the clips in order", [calls.length, calls[0]], [1, ["file:///seg1.mov", "file:///seg2.mov", "file:///seg3.mov"]]);
  eq("the result is ONE untrimmed video clip of the merged length", [r.ok, r.clip.type, r.clip.uri, r.clip.durationMs, r.clip.trimStartMs, r.clip.trimEndMs], [true, "video", "file:///merged.mp4", 12345, 0, 12345]);
  eq("the originals are listed, in order, and not touched", r.mergedFrom, ["file:///seg1.mov", "file:///seg2.mov", "file:///seg3.mov"]);
  eq("progress is clamped to 0..1", progress, [0.5, 1]);
  // The single clip is exactly what the AI pipeline asks for (edit.tsx autoEditPossible)
  const clip = r.clip;
  const trimEnd = clip.trimEndMs ?? 0;
  ok("it satisfies the AI pipeline's conditions (one video, a known length, untrimmed)", clip.type === "video" && clip.durationMs > 0 && (clip.trimStartMs ?? 0) === 0 && !(trimEnd > 0 && trimEnd < clip.durationMs - 50));
  ok("and the editor swaps it in as the only clip, which starts the AI pipeline (clips.length === 1)", /replaceClips\(\[result\.clip\]\)/.test(edit) && /clips\.length === 1 &&/.test(edit));

  // failures
  let attempts = 0;
  const flaky = async () => { attempts++; if (attempts === 1) throw new Error("native render failed"); return { uri: "file:///merged2.mp4", durationMs: 5000 }; };
  const bad = await mergeVideoClips({ clips: [v(1), v(2)], render: flaky, newId });
  eq("a failed merge is a result with a message, not a throw", [bad.ok, bad.message], [false, "native render failed"]);
  const again = await mergeVideoClips({ clips: [v(1), v(2)], render: flaky, newId });
  eq("Retry merges again and succeeds", [again.ok, again.clip.uri], [true, "file:///merged2.mp4"]);
  eq("an empty result is a failure too", (await mergeVideoClips({ clips: [v(1), v(2)], render: async () => ({ uri: "", durationMs: 0 }), newId })).ok, false);
  eq("a render that rejects with a string is handled", (await mergeVideoClips({ clips: [v(1), v(2)], render: () => Promise.reject("boom"), newId })).message, "boom");
  eq("fewer than two clips is refused", (await mergeVideoClips({ clips: [v(1)], render: render, newId })).ok, false);
  eq("a progress callback that throws cannot break the merge", (await mergeVideoClips({ clips: [v(1), v(2)], render, newId, onProgress: () => { throw new Error("ui"); } })).ok, true);
  eq("the message shown", MERGE_FAILED_TEXT, "Couldn't prepare your video.");

  ok("the editor shows Preparing your video… with progress, and Retry on a failure", /MERGE_PREPARING_TEXT/.test(edit) && /accessibilityLabel="Retry"/.test(edit) && /handleMergeRetry/.test(edit));
  ok("a failure is recorded and never throws out of the screen", /recordClientError\(new Error\(result\.message\), \{ kind: "mergeClips"/.test(edit));
  ok("captions and the render-ahead wait for the merge", /mergeUi\.kind === "idle" && !autoEditRunning/.test(edit) && /hold: captionsBusy \|\| mergeUi\.kind !== "idle"/.test(edit));
  ok("a draft is not merged again", /shouldMerge\(initialClips, \{ isDraft: !!draftId \}\)/.test(edit));
  ok("the originals are kept: the merge never deletes a source", !/deleteAsync\(originalClipsRef/.test(edit) && /originalClipsRef/.test(edit));
  const nat = read("../lib/mergeNative.ts");
  ok("the merge is the existing native render with no cuts and no overlays, one render at a time", /renderAsync\(/.test(nat) && /overlays: \[\]/.test(nat) && /acquireNative\(\)/.test(nat) && /trimStartMs: 0, trimEndMs: WHOLE_FILE_MS/.test(nat));
  ok("a hung render is cancelled", /cancelRender\(\)/.test(nat) && /MERGE_TIMEOUT_MS/.test(nat));
  ok("a merged project saves as a single-source draft (the draft code takes the one clip)", /permanentClips\.every\(\(c\) => c\.uri === sourceUri\)/.test(edit));
}

// ── camera ──
{
  const cam = read("../hooks/useCameraRecorder.ts");
  ok("no segment is saved to the camera roll", !/saveToGallery\s*\(/.test(cam) && !/saveToLibraryAsync/.test(cam) && !/useMediaLibraryPermissions/.test(cam));
  ok("segments still reach the editor as clips (one per segment)", /appendClip\(clip\)/.test(cam));
  ok("the final edited video is still saved by the Save to camera roll switch", /startPostExport\(/.test(edit));
}

// ── camera roll multi-select ──
{
  let n = 0;
  const id = () => `i${++n}`;
  const a = (uri, duration, type = "video") => ({ uri, duration, type });
  const three = validateSelection([a("b.mov", 5000), a("a.mov", 7000), a("c.mov", 3000)], 300000, id);
  eq("several videos keep the order they were picked", [three.ok, three.kind, three.clips.map((c) => c.uri)], [true, "multi", ["b.mov", "a.mov", "c.mov"]]);
  eq("durations are carried (ms)", three.clips.map((c) => c.durationMs), [5000, 7000, 3000]);
  eq("one video or photo is the single path, as before", [validateSelection([a("a.mov", 5000)], 300000, id).kind, validateSelection([a("p.jpg", null, "image")], 300000, id).kind], ["single", "single"]);
  const mixed = validateSelection([a("a.mov", 5000), a("p.jpg", null, "image")], 300000, id);
  eq("videos only when several are picked", [mixed.ok, mixed.reason], [false, "mixed"]);
  const long = validateSelection([a("a.mov", 200000), a("b.mov", 150000)], 300000, id);
  eq("the total length across all videos is limited (300 s)", [long.ok, long.reason], [false, "too-long"]);
  eq("exactly at the limit is allowed", validateSelection([a("a.mov", 150000), a("b.mov", 150000)], 300000, id).ok, true);
  eq("one video over the limit is refused as before", validateSelection([a("a.mov", 400000)], 300000, id).reason, "too-long");
  eq("at most 10 videos", [MAX_IMPORT_VIDEOS, validateSelection(Array.from({ length: 11 }, (_, i) => a(`${i}.mov`, 1000)), 300000, id).reason, validateSelection(Array.from({ length: 10 }, (_, i) => a(`${i}.mov`, 1000)), 300000, id).ok], [10, "too-many", true]);
  eq("an empty pick is refused", validateSelection([], 300000, id).reason, "empty");

  // Arrange
  const list = ["x", "y", "z"];
  eq("Arrange: move a clip earlier / later", [moveItem(list, 2, 0), moveItem(list, 0, 1)], [["z", "x", "y"], ["y", "x", "z"]]);
  eq("moves are clamped and never change the original list", [moveItem(list, 0, -5), moveItem(list, 1, 99), list], [["x", "y", "z"], ["x", "z", "y"], ["x", "y", "z"]]);
  eq("Arrange: remove a clip", removeItem(list, 1), ["x", "z"]);
  eq("the total duration", totalDurationMs([{ durationMs: 1000 }, { durationMs: 2500 }, {}]), 3500);

  const sheet = read("../components/PostChoiceSheet.tsx");
  ok("the picker allows several, ordered, up to 10", /allowsMultipleSelection: !photoCompatible/.test(sheet) && /orderedSelection: true, selectionLimit: MAX_IMPORT_VIDEOS/.test(sheet));
  ok("the pick is validated (total duration, videos only) before anything opens", /validateSelection\(result\.assets, MAX_VIDEO_SECONDS \* 1000, newClipId\)/.test(sheet));
  ok("several videos go to the Arrange step first; Combine continues to the editor in that order", /setArranging\(checked\.clips\)/.test(sheet) && /params: \{ clips: JSON\.stringify\(list\) \}/.test(sheet));
  const arrange = read("../components/ArrangeClips.tsx");
  ok("Arrange has reorder and remove controls with 44 pt targets and a Combine button", /Move clip/.test(arrange) && /Remove clip/.test(arrange) && /width: 44, height: 44/.test(arrange) && /Combine/.test(arrange));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
