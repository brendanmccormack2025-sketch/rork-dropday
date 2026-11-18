#!/usr/bin/env node
/** The benchmark projections (lib/footageBenchmark.ts): the numbers the owner reads off the phone must be right. */
import { describeProjection, project } from "../lib/footageBenchmark.ts";
let failed = 0;
function eq(name, actual, expected) { const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`); }
const r = (x) => Math.round(x * 10) / 10;
// the measured speed so far: 25 s of work per minute of video; a 60 s slice at 5 MB
const p = project({ label: "today", maxSide: 1280, sliceSeconds: 60, wallMs: 25_000, bytes: 45_000_000 });
eq("25 s per minute of video is 2.4x faster than real time, and 60 minutes take 25 minutes to prepare", [r(p.secondsPerMinute), r(p.realtimeFactor), r(p.projectedMinutes)], [25, 2.4, 25]);
eq("45 MB per minute is 6 Mbps, 2.7 GB per hour, and 19 Mbps at 80 % uploads it in about 23.7 minutes", [r(p.mbPerMinute), r(p.mbps), r(p.projectedGB), r(p.projectedUploadMinutes)], [45, 6, 2.7, 23.7]);
const px = project({ label: "proxy", maxSide: 640, sliceSeconds: 60, wallMs: 2_000, bytes: 3_750_000 });
eq("a proxy of 0.5 Mbps (3.75 MB per minute) is 225 MB per hour and uploads in about 2 minutes; at 2 s per minute the hour takes 2 minutes", [r(px.mbps), r(px.projectedGB * 1000), r(px.projectedUploadMinutes), r(px.projectedMinutes), r(px.realtimeFactor)], [0.5, 225, 2, 2, 30]);
eq("a slice of a different length is scaled per minute", r(project({ label: "x", maxSide: 640, sliceSeconds: 30, wallMs: 5_000, bytes: 1_000_000 }).secondsPerMinute), 10);
eq("the lines say it in words", describeProjection(p), ["today: 25 s of work per minute of video (2.4x faster than real time)", "size: 45 MB per minute (6 Mbps)", "60 minutes: about 25 min to prepare, 2.7 GB, about 23.7 min to upload at 19 Mbps"]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
