#!/usr/bin/env node
/** Segmented footage helpers (lib/footageSegments.ts): which segments cover a section, whether a section can be made, the time left, the free-space checks. */
import { DEFAULT_UPLOAD_BYTES_PER_SECOND, MAX_SECTION_SECONDS, PICK_MIN_FREE_BYTES, WORKING_SPACE_BYTES, coveringSegments, estimateRemainingSeconds, etaLabel, sectionCheck, sectionRanges, spaceCheck } from "../lib/footageSegments.ts";
let failed = 0;
function eq(name, actual, expected) { const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`); }
// a 10-minute video in 1-minute segments, the first 6 uploaded; strings as Postgres returns numerics
const SEG = (n, ready) => [...Array(n).keys()].map((i) => ({ idx: i, start_s: `${i * 60}.00`, end_s: `${(i + 1) * 60}.00`, status: i < ready ? "ready" : "uploading" }));
const S = SEG(10, 6);

eq("a section inside one segment needs that one; one across a boundary needs both; exactly on a boundary does not need the next", [coveringSegments(S, 10, 50).map((s) => s.idx), coveringSegments(S, 50, 70).map((s) => s.idx), coveringSegments(S, 0, 60).map((s) => s.idx), coveringSegments(S, 60, 120).map((s) => s.idx)], [[0], [0, 1], [0], [1]]);
eq("a 3-minute section starting mid-segment needs 4 segments at most (so at most 4 minutes are downloaded)", coveringSegments(S, 90, 270).map((s) => s.idx), [1, 2, 3, 4]);
eq("the pieces to keep: the first is trimmed at its start, the last at its end, the middle ones whole (milliseconds into each segment's own file)", sectionRanges(S, 50, 190).map((r) => [r.segment.idx, r.startMs, r.endMs]), [[0, 50000, 60000], [1, 0, 60000], [2, 0, 60000], [3, 0, 10000]]);
eq("the kept pieces add up to exactly the section length", sectionRanges(S, 50.5, 190.25).reduce((a, r) => a + (r.endMs - r.startMs), 0), 139750);
eq("a section's pieces keep the order of the video even if the list is shuffled", sectionRanges([S[2], S[0], S[1]], 0, 180).map((r) => r.segment.idx), [0, 1, 2]);

const V = 600;
eq("a good section (in order, within 3 minutes, all parts uploaded) can be made", sectionCheck(S, 10, 100, V), { ok: true, seconds: 90 });
eq("exactly 3 minutes is fine, one second more is not", [sectionCheck(S, 0, 180, V).ok, sectionCheck(S, 0, 181, V).ok, sectionCheck(S, 0, 181, V).reason], [true, false, `A section can be at most ${MAX_SECTION_SECONDS / 60} minutes. Move the start or the end.`]);
eq("no start or end yet, end before start and a zero-length section are refused with a reason", [sectionCheck(S, null, 5, V).reason, sectionCheck(S, 5, null, V).reason, sectionCheck(S, 50, 40, V).reason, sectionCheck(S, 50, 50, V).ok], ["Mark where the section starts and ends.", "Mark where the section starts and ends.", "The end has to be after the start.", false]);
eq("a section that needs a part that is still uploading is refused and names the part", [sectionCheck(S, 330, 400, V).ok, sectionCheck(S, 330, 400, V).reason], [false, "Part 7 of this video is still uploading. Try again in a moment, or choose an earlier section."]);
eq("a section that ends in the last uploaded part is fine; one that reaches the next is not", [sectionCheck(S, 300, 360, V).ok, sectionCheck(S, 300, 361, V).ok], [true, false]);
eq("outside the video is refused", [sectionCheck(S, -5, 20, V).ok, sectionCheck(S, 100, 700, V).ok], [false, false]);

// time left
eq("time left: each remaining segment costs the slower of cut and upload, plus the shorter once to fill the pipeline", [estimateRemainingSeconds({ remaining: 4, segmentSeconds: 60, cutSeconds: [20, 20], uploadSeconds: [10] }), estimateRemainingSeconds({ remaining: 4, segmentSeconds: 60, cutSeconds: [20], uploadSeconds: [30, 30, 30] }), estimateRemainingSeconds({ remaining: 0, segmentSeconds: 60, cutSeconds: [], uploadSeconds: [] })], [90, 140, 0]);
eq("only the last 3 measurements count (a slow start does not stick)", estimateRemainingSeconds({ remaining: 1, segmentSeconds: 60, cutSeconds: [100, 20, 20, 20], uploadSeconds: [5] }), 25);
eq("before anything is measured: cut at the measured 25 s per minute of video, upload from the segment size and 19 Mbps at 80 %", (() => { const e = estimateRemainingSeconds({ remaining: 3, segmentSeconds: 60, cutSeconds: [], uploadSeconds: [] }); const up = (60 * 750_000) / DEFAULT_UPLOAD_BYTES_PER_SECOND; return [Math.round(e), Math.round(3 * Math.max(25, up) + Math.min(25, up))]; })().every((x, _, a) => x === a[0]), true);
eq("a 60-minute upload on 19 Mbps, first estimate: about 25 minutes (cutting at 25 s per minute is the slow part; the upload of ~45 MB parts at 19 Mbps takes ~24 s each)", Math.round(estimateRemainingSeconds({ remaining: 60, segmentSeconds: 60, cutSeconds: [], uploadSeconds: [] }) / 60), 25);
eq("labels never show false precision", [etaLabel(0), etaLabel(30), etaLabel(60), etaLabel(61), etaLabel(14 * 60), etaLabel(89 * 60), etaLabel(90 * 60), etaLabel(125 * 60)], ["", "less than a minute left", "about 1 minute left", "about 2 minutes left", "about 14 minutes left", "about 89 minutes left", "about 1 h 30 min left", "about 2 h 5 min left"]);

// free space
eq("free space: enough, not enough (with the numbers), and unknown never blocks", [spaceCheck(2 * 1024 ** 3, WORKING_SPACE_BYTES).ok, spaceCheck(100 * 1024 ** 2, WORKING_SPACE_BYTES).ok, spaceCheck(null, WORKING_SPACE_BYTES).ok, spaceCheck(100 * 1024 ** 2, WORKING_SPACE_BYTES).message], [true, false, true, "Not enough free space on this phone (0.1 GB free, about 0.6 GB needed). Free up some space and try again."]);
eq("the working space is 600 MB and the room asked for before the camera roll opens is 1.5 GB", [WORKING_SPACE_BYTES, PICK_MIN_FREE_BYTES], [600 * 1024 ** 2, 1.5 * 1024 ** 3]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
