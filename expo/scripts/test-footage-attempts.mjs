#!/usr/bin/env node
/** The owner's footage attempts list (lib/footageAttempts.ts): newest first, at most 20, one row per attempt, readable lines. */
import { MAX_ATTEMPTS, attemptFromItem, describeAttempt, upsertAttempt } from "../lib/footageAttempts.ts";
let failed = 0;
function eq(name, actual, expected) { const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`); }
const A = (id, at, o = {}) => ({ id, at, name: `v${id}`, stage: "uploading the video", state: "uploading", ...o });
let list = [];
for (let i = 1; i <= 25; i++) list = upsertAttempt(list, A(String(i), i));
eq("only the last 20 are kept, newest first", [list.length, list[0].id, list.at(-1).id, MAX_ATTEMPTS], [20, "25", "6", 20]);
list = upsertAttempt(list, A("10", 10, { state: "error", stage: "registering the video", error: "boom" }));
eq("a changed attempt replaces its row instead of adding one", [list.length, list.find((a) => a.id === "10").state], [20, "error"]);
eq("an attempt is made from a list item with its step, error, length, sizes and how it was picked", attemptFromItem({ localId: "L1", sourceUri: "ph://x", name: "clip", durationSeconds: 61.5, width: 1280, height: 720, state: "error", progress: 0.2, stage: "preparing the video", error: "Stopped while preparing the video. x", rawError: "export failed", sourceSize: 52428800, sizeBytes: 20971520, createdAt: 5, sourceScheme: "ph", note: "n" }),
  { id: "L1", at: 5, name: "clip", stage: "preparing the video", state: "error", error: "Stopped while preparing the video. x", rawError: "export failed", note: "n", durationSeconds: 61.5, sourceSize: 52428800, sizeBytes: 20971520, width: 1280, height: 720, scheme: "ph" });
eq("the lines show step, length, both file sizes, how it was picked, the message and the raw reason", describeAttempt({ id: "a", at: 1, name: "n", stage: "preparing the video", state: "error", error: "E", rawError: "R", durationSeconds: 61, sourceSize: 52428800, sizeBytes: 20971520, width: 1280, height: 720, scheme: "file" }),
  ["step: preparing the video (error)", "length: 1:01 · picked file: 50.0 MB · uploaded file: 20.0 MB · 1280×720", "picked as: file://", "message: E", "reason: R"]);
eq("unknown values say unknown", describeAttempt({ id: "a", at: 1, name: "n", stage: "waiting", state: "queued" }), ["step: waiting (queued)", "length: unknown · picked file: unknown · uploaded file: unknown"]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
