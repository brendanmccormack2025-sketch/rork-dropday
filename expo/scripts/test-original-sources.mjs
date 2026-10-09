#!/usr/bin/env node
/**
 * Every path that can bring the "original" clips back loads only the merged file; the owner debug says exactly what
 * the players hold; a saved draft keeps one source.
 *   node --experimental-strip-types --no-warnings scripts/test-original-sources.mjs
 */
import { readFileSync } from "node:fs";
import { formatPlaybackDebug } from "../lib/autoEdit/debugText.ts";
import { enforceMergedSource } from "../lib/mergedSource.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const SEGS = ["file:///seg1.mov", "file:///seg2.mov"];
const MERGED = "file:///cache/render_x.mp4";

// ── owner debug ──
{
  const good = formatPlaybackDebug({
    merged: { uri: MERGED, durationMs: 90000 },
    segmentUris: SEGS,
    clips: [{ uri: MERGED, trimStartMs: 0, trimEndMs: 90000 }],
    players: [
      { name: "A", uri: MERGED, durationMs: 90000, status: "readyToPlay", positionMs: 4000 },
      { name: "B", uri: null, durationMs: 0, status: "idle", positionMs: 0 },
      { name: "preview", uri: null, durationMs: 0, status: "idle", positionMs: 0 },
    ],
    lastReset: { at: 1, uris: [MERGED], ready: true, steps: ["pause", "replace", "ready", "seek"], ms: 240 },
  }).join("\n");
  ok("it lists the merged file with its duration, the segments, and the timeline clips", good.includes(`Merged file: ${MERGED} (1:30.0)`) && good.includes("Pre-merge segments: seg1.mov, seg2.mov") && good.includes("Timeline clips: render_x.mp4 0:00.0-1:30.0"));
  ok("and each player's exact uri, duration, status and position", good.includes(`Player A: ${MERGED}; duration 1:30.0; status readyToPlay; position 0:04.0`) && good.includes("Player B: nothing loaded"));
  ok("and the last Keep original / undo reset (files, ready, steps, time)", good.includes("Last reset (Keep original/undo): render_x.mp4; ready yes; pause > replace > ready > seek; 240 ms"));
  ok("a healthy project says so", good.includes("Timeline uses only the merged file: yes") && good.includes("A player holds a pre-merge segment: no"));
  const bad = formatPlaybackDebug({
    merged: { uri: MERGED, durationMs: 90000 }, segmentUris: SEGS,
    clips: [{ uri: SEGS[0], trimStartMs: 0, trimEndMs: 5000 }],
    players: [{ name: "A", uri: SEGS[0], durationMs: 5000, status: "readyToPlay", positionMs: 0 }],
  }).join("\n");
  ok("a segment on the timeline or in a player is flagged loudly", bad.includes("Timeline uses only the merged file: NO") && bad.includes("A player holds a pre-merge segment: YES (A)"));
  ok("an unmerged project does not claim anything about a merge", !formatPlaybackDebug({ merged: null, segmentUris: [], clips: [], players: [] }).join("\n").includes("Timeline uses only"));
  const edit = read("../app/edit.tsx");
  ok("Share AI debug (owner) includes it, from the real refs and players", /playback: \{\s*merged: mergedRef\.current/.test(edit) && /uri: loadedAUriRef\.current/.test(edit) && /uri: previewUriRef\.current/.test(edit) && /lastReset: lastResetRef\.current/.test(edit));
}

// ── every path that restores clips ──
{
  const edit = read("../app/edit.tsx");
  const segmentsOnly = [{ id: "s1", uri: SEGS[0] }, { id: "s2", uri: SEGS[1] }];
  eq("a snapshot made of segments restores nothing in a merged project", enforceMergedSource(segmentsOnly, { uri: MERGED }, SEGS).clips, []);
  ok("replaceClips (autoEdit, Review, Use original) enforces it", /const replaceClips = useCallback\(\(requested: DraftClip\[\]\) =>/.test(edit) && /enforceMergedSource\(\s*requested/.test(edit));
  ok("undo and redo of clip snapshots enforce it", /const snapshot = withMergedSource\(raw\)/.test(edit) && (edit.match(/withMergedSource\(raw\)/g) ?? []).length === 2);
  ok("Keep original and Original video are decision edits on the merged source (userEdit -> commitDecisions), never old clips", /userEdit\(cutCategoriesOff\)/.test(edit) && /userEdit\(allCategoriesOff\)/.test(edit));
  ok("'Use original' restores the merged clip the auto edit started from (never a segment)", /replaceClips\(\[autoEditSession\.original\]\)/.test(edit) && /original = \{ \.\.\.current\[0\]!, trimStartMs: 0/.test(edit));
  // draft save: one copy per source file
  ok("a saved draft copies each distinct source ONCE, all clips share it (so the edit state is kept and one file plays)", /const copies = new Map<string, Promise<string>>\(\)/.test(edit) && /copyOnce\(c, i\)/.test(edit) && /permanentClips\.every\(\(c\) => c\.uri === sourceUri\)/.test(edit));
  ok("(the old per-clip copy is gone)", !/const destUri = `\$\{draftDir\}\$\{c\.id\}/.test(edit) || /copies\.set\(c\.uri, job\)/.test(edit));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
