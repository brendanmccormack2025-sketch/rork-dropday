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
  ok("captions and the render-ahead wait for the merge", /transcriptionGate\(\{ merge: mergeUi\.kind/.test(edit) && /hold: captionsBusy \|\| mergeUi\.kind !== "idle"/.test(edit));
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

// ── camera roll: one video only (MVP) ──
{
  const sheet = read("../components/PostChoiceSheet.tsx");
  ok("the picker takes one item, no multi-select and no Arrange step", /allowsMultipleSelection: false/.test(sheet) && !/orderedSelection|selectionLimit|ArrangeClips|validateSelection/.test(sheet));
  ok("a video over the existing single-video limit is refused", /\(asset\.duration \?\? 0\) > MAX_VIDEO_SECONDS \* 1000/.test(sheet));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
