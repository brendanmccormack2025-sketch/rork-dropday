#!/usr/bin/env node
/**
 * A merged project (camera segments with flips): Keep original plays the MERGED file only, directly; the merged
 * file is checked to play straight through its joins; undo restores the cuts.
 *   node --experimental-strip-types --no-warnings scripts/test-merged-keep-original.mjs
 */
import { readFileSync } from "node:fs";
import { makeDecision, newEditState, renderClipsOf } from "../lib/autoEdit/decisions.ts";
import { cutCategoriesOff } from "../lib/autoEdit/editPanel.ts";
import { isPlayingWholeSource } from "../lib/autoEdit/noCuts.ts";
import { pushEdit, emptyHistory, undoEdit } from "../lib/autoEdit/history.ts";
import { enforceMergedSource, playerUris } from "../lib/mergedSource.ts";
import { joinTimesMs, verifyJoins } from "../lib/mergeVerify.ts";
import { mergeTimingReport } from "../lib/mergeTiming.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const SEGS = ["file:///seg1.mov", "file:///seg2.mov", "file:///seg3.mov"];
const MERGED = "file:///cache/render_x.mp4";
const DUR = 45000;
const cut = (s, e) => makeDecision("silenceCut", s, e);
const edited = newEditState(MERGED, [cut(4000, 6000), cut(20000, 21500)]);
const clipsOf = (state) => renderClipsOf(state, DUR).map((c, i) => ({ id: `k${i}`, uri: c.uri, trimStartMs: c.trimStartMs, trimEndMs: c.trimEndMs, durationMs: DUR }));

// ── Keep original on a merged project loads only the merged file ──
{
  eq("the edited timeline is clips of the merged file only", playerUris(clipsOf(edited)), [MERGED]);
  const kept = cutCategoriesOff(edited);
  const keptClips = clipsOf(kept);
  eq("after Keep original: one clip, the whole merged file", [keptClips.length, keptClips[0].uri, keptClips[0].trimStartMs, keptClips[0].trimEndMs], [1, MERGED, 0, DUR]);
  eq("the player loads the merged URI and nothing else (no pre-merge segment)", playerUris(keptClips).filter((u) => SEGS.includes(u)), []);
  ok("and it is played directly (no cuts: no preview render, no wait, no live multi-clip seams)", isPlayingWholeSource(keptClips, kept, DUR));
  const undone = undoEdit(pushEdit(emptyHistory(), edited), kept);
  eq("undo restores the cut version, still of the merged file", [undone.state === edited, playerUris(clipsOf(undone.state))], [true, [MERGED]]);
  ok("(the normal preview applies again: cuts are active)", !isPlayingWholeSource(clipsOf(undone.state), undone.state, DUR));
}

// ── the editor never takes a pre-merge segment ──
{
  const mixed = [{ id: "a", uri: SEGS[0] }, { id: "m", uri: MERGED }, { id: "b", uri: SEGS[1] }];
  const r = enforceMergedSource(mixed, { uri: MERGED }, SEGS);
  eq("segment clips are dropped, the merged clip stays", [r.clips.map((c) => c.id), r.dropped.map((c) => c.id)], [["m"], ["a", "b"]]);
  eq("an unmerged project is left alone", enforceMergedSource(mixed, null, SEGS).clips.length, 3);
  eq("the merged file is never treated as a segment", enforceMergedSource([{ id: "m", uri: MERGED }], { uri: MERGED }, [...SEGS, MERGED]).clips.length, 1);
  const edit = read("../app/edit.tsx");
  ok("replaceClips enforces it (and logs segmentInTimeline)", /enforceMergedSource\(\s*requested,\s*mergedRef\.current,\s*originalClipsRef\.current\.map/.test(edit) && /kind: "segmentInTimeline"/.test(edit));
  ok("Keep original logs which files the player loads (dev)", /\[keepOriginal\] player loads/.test(edit) && /playerUris\(clipsRef\.current\)/.test(edit));
  ok("the pre-merge segments are only used to build the merge", (edit.match(/originalClipsRef\.current/g) ?? []).length <= 5);
}

// ── the merged file plays straight through its joins ──
{
  const segMs = [12000, 18000, 15000];
  eq("the joins are at the running totals of the segments", joinTimesMs(segMs), [12000, 30000]);
  const delay = async () => {};
  function player({ stallAt = null, durationMs = 45000 }) {
    let pos = 0, playing = false;
    return {
      ready: async () => true,
      seekMs: (ms) => { pos = ms; },
      play: () => { playing = true; },
      pause: () => { playing = false; },
      // each poll advances 150 ms while playing, but never past a stall point
      positionMs: () => { if (playing) pos = stallAt !== null && pos >= stallAt - 700 && pos < stallAt + 5000 && pos >= stallAt ? pos : Math.min(pos + 150, stallAt !== null && pos < stallAt ? stallAt : Infinity); return pos; },
      durationMs: () => durationMs,
      release: () => {},
    };
  }
  const good = await verifyJoins({ createPlayer: () => player({}), joinsMs: [12000, 30000], expectedMs: 45000, delay });
  eq("a healthy file passes every join and the length matches", [good.stalled, good.durationOk, good.joins.map((j) => j.ok)], [false, true, [true, true]]);
  const bad = await verifyJoins({ createPlayer: () => player({ stallAt: 12000 }), joinsMs: [12000, 30000], expectedMs: 45000, delay });
  eq("a file that stops at the first join is reported with its numbers", [bad.stalled, bad.joins[0].ok, bad.joins[0].atMs, bad.joins[0].reachedMs <= 12000], [true, false, 12000, true]);
  const short = await verifyJoins({ createPlayer: () => player({ durationMs: 12000 }), joinsMs: [12000, 30000], expectedMs: 45000, delay });
  eq("a file whose length is only the first segment's is reported", [short.durationOk, short.playerDurationMs, short.expectedMs], [false, 12000, 45000]);
  eq("a player that cannot load is reported as not ok", (await verifyJoins({ createPlayer: () => ({ ...player({}), ready: async () => false }), joinsMs: [1000], expectedMs: 5000, delay })).durationOk, false);
  const t = (o = {}) => ({ durationMs: 15000, videoStartMs: 0, videoDurationMs: 15000, audioStartMs: 0, audioDurationMs: 15000, ...o });
  eq("the merge report carries each segment's length, to place the joins", mergeTimingReport([t({ durationMs: 12000 }), t({ durationMs: 18000 }), t()], t({ durationMs: 45000 }), 2).sourceDurationsMs, [12000, 18000, 15000]);
  const edit = read("../app/edit.tsx");
  ok("after the merge the file is verified in the background and a stall is logged with its numbers", /verifyJoins\(\{\s*createPlayer: \(\) => createVerifyPlayer\(result\.clip\.uri\)/.test(edit) && /kind: "mergeVerify"/.test(edit) && /v\.stalled \|\| !v\.durationOk/.test(edit));
  const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
  ok("native: a clip's range ends where its video track ends (no hole in the picture at a join)", /if end > sourceVideo\.timeRange\.end \{ end = sourceVideo\.timeRange\.end \}/.test(swift));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
