#!/usr/bin/env node
/**
 * The AI editor for every user: gating, captions on by default, delete line, Post waiting for captions,
 * captions for several source files, and no speech access (silence cuts only).
 *
 *   node --experimental-strip-types scripts/test-rollout.mjs
 */
import { CAPTIONS_ON_BY_DEFAULT, aiEditorFeatures } from "../lib/autoEdit/rollout.ts";
import { OWNER_USER_ID } from "../constants/debug.ts";
import { categoryRows } from "../lib/autoEdit/editPanel.ts";
import { buildAiEditState } from "../lib/autoEdit/plan.ts";
import { keepRangesOf, newEditState, setCaptionEdits, setCategoryEnabled } from "../lib/autoEdit/decisions.ts";
import { canRedo, canUndo, emptyHistory, pushEdit, redoEdit, undoEdit } from "../lib/autoEdit/history.ts";
import { createAnalysisCache } from "../lib/autoEdit/analysisCache.ts";
import { applyLineEdit, buildCaptionLines } from "../lib/transcription/captionLines.ts";
import { combineSources, distinctSources, mapWordsToClips } from "../lib/transcription/multiSource.ts";
import { POST_WAIT_MS, settleCaptionsForPost, waitUntil } from "../lib/postWait.ts";
import { SENSITIVITY_PRESETS } from "../lib/silenceDetection.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const w = (text, startMs, endMs) => ({ text, startMs, endMs });
const URI = "file:///a.mov";
const WIN = 20;
function windowsOf(totalMs, stretches) {
  const out = new Array(totalMs / WIN).fill(-80);
  for (const [from, to, db] of stretches) for (let i = from / WIN; i < to / WIN; i++) out[i] = typeof db === "function" ? db(i - from / WIN) : db;
  return out;
}

// ── gating ──
{
  const stranger = "11111111-2222-3333-4444-555555555555";
  const user = aiEditorFeatures({ userId: stranger, isRootPost: true });
  eq("a regular user gets the whole AI editor", [user.transcription, user.captions, user.captionControls, user.hookTrim, user.umCuts, user.laughProtection, user.aiEditsPanel, user.cutMarkers], Array(8).fill(true));
  eq("...but never the debug view or emphasis proposals", [user.debugView, user.emphasis], [false, false]);
  const owner = aiEditorFeatures({ userId: OWNER_USER_ID, isRootPost: true });
  eq("the owner also gets the debug view and emphasis", [owner.debugView, owner.emphasis], [true, true]);
  eq("a signed-out or missing user is a regular user", [aiEditorFeatures({ userId: null, isRootPost: true }).debugView, aiEditorFeatures({ userId: undefined, isRootPost: true }).captions], [false, true]);
  const reaction = aiEditorFeatures({ userId: stranger, isRootPost: false });
  eq("a reaction is not rendered at post time: no transcription or captions there, the panel stays", [reaction.transcription, reaction.captions, reaction.umCuts, reaction.aiEditsPanel], [false, false, false, true]);
  eq("captions are on by default for every new edit", CAPTIONS_ON_BY_DEFAULT, true);

  const state = newEditState(URI);
  const rowsUser = categoryRows(state, { owner: user.debugView, captionLines: 3, captionsOn: CAPTIONS_ON_BY_DEFAULT });
  eq("the AI edits panel shows every cut type and captions to a regular user", rowsUser.map((r) => r.id), ["cuts", "hook", "fillers", "ums", "protect", "captions"]);
  eq("...captions row: on, with the line count", rowsUser.find((r) => r.id === "captions"), { id: "captions", label: "Captions", type: "caption", count: 3, enabled: true });
  eq("the owner's panel adds Zooms (emphasis)", categoryRows(state, { owner: true, captionLines: 0, captionsOn: true }).map((r) => r.id).includes("zooms"), true);
  eq("a regular user's panel never has Zooms", rowsUser.some((r) => r.id === "zooms"), false);
}

// ── all cut types come out of the plan, whoever the user is ──
{
  const TEXTS = ["hello", "there", "world", "about", "think", "right", "which", "other", "might", "could"];
  const words = TEXTS.map((text, i) => w(text, 1000 + i * 1700, 1440 + i * 1700));
  // a method-1 filler word, a um between words, and a laugh
  words.splice(4, 0, w("um", 1000 + 3 * 1700 + 700, 1000 + 3 * 1700 + 1000));
  const total = 22000;
  const stretches = [
    ...words.map((x) => [x.startMs, x.endMs, -28]),
    [words[1].endMs + 200, words[1].endMs + 500, -30], // an um between two words
  ];
  const state = buildAiEditState({ uri: URI, durationMs: total, windows: windowsOf(total, stretches), silenceOptions: SENSITIVITY_PRESETS.tight, words });
  const types = [...new Set(state.decisions.filter((d) => d.state === "applied").map((d) => d.type))].sort();
  eq("the plan applies the filler word and the um (and silence cuts)", [types.includes("fillerCut"), types.includes("umCut")], [true, true]);
  // a 3 s pulsed laugh in a pause: protected
  const before = Array.from({ length: 7 }, (_, i) => w(`a${i}`, 500 + i * 640, 940 + i * 640));
  const LS = before[6].endMs + 600;
  const after = Array.from({ length: 7 }, (_, i) => w(`b${i}`, LS + 3000 + 600 + i * 640, LS + 3000 + 1040 + i * 640));
  const lw = [...before, ...after];
  const lt = Math.ceil((after[6].endMs + 1500) / 1000) * 1000;
  const laughState = buildAiEditState({ uri: URI, durationMs: lt, windows: windowsOf(lt, [...lw.map((x) => [x.startMs, x.endMs, -28]), [LS, LS + 3000, (i) => (i % 10 < 5 ? -22 : -50)]]), silenceOptions: SENSITIVITY_PRESETS.tight, words: lw });
  eq("a laugh is protected", laughState.decisions.some((d) => d.type === "laughProtect" && d.state === "applied"), true);
}

// ── no speech access: silence cuts only ──
{
  const total = 12000;
  const windows = windowsOf(total, [[0, 2000, -28], [6000, 8000, -28]]);
  const denied = buildAiEditState({ uri: URI, durationMs: total, windows, silenceOptions: SENSITIVITY_PRESETS.tight, words: null });
  eq("with no transcript the plan is silence cuts only", [...new Set(denied.decisions.map((d) => d.type))], ["silenceCut"]);
  eq("...and those cuts really shorten the video", keepRangesOf(denied, total).length >= 2, true);
  const cache = createAnalysisCache({
    stat: async (uri) => ({ uri, size: 1, mtime: 1 }),
    loadLoudness: async () => ({ durationMs: total, windows }),
    transcribe: async () => ({ status: "denied", code: "ERR_SPEECH_PERMISSION_DENIED", message: "denied" }),
  });
  const r = await cache.transcriptWithInfo(URI);
  eq("a denied speech permission is reported as denied (never an empty transcript) and is not cached", [r.result.status, r.fromCache], ["denied", false]);
}

// ── Delete line ──
{
  const talk = [w("one", 0, 400), w("two", 450, 800), w("three", 850, 1200), w("four", 2500, 2900), w("five", 2950, 3300), w("six", 3350, 3700)];
  const whole = [{ startMs: 0, endMs: 4000 }];
  const lines = buildCaptionLines(talk, {}, whole);
  eq("two caption lines to start with", lines.map((l) => l.text), ["one two three", "four five six"]);
  const edits = applyLineEdit(talk, {}, lines[1], "");
  eq("Delete line stores an empty text for each source word of that line", edits, { 3: "", 4: "", 5: "" });
  eq("the line is gone and the other stays", buildCaptionLines(talk, edits, whole).map((l) => l.text), ["one two three"]);
  // the cuts change: the deletion still applies to the same words
  const cut = [{ startMs: 0, endMs: 1500 }, { startMs: 2400, endMs: 4000 }];
  eq("it survives cut changes (stored against source words)", buildCaptionLines(talk, edits, cut).map((l) => l.text), ["one two three"]);
  eq("...and a different cut still shows the other words", buildCaptionLines(talk, {}, [{ startMs: 2400, endMs: 4000 }]).map((l) => l.text), ["four five six"]);
  // reversible with undo / redo through the edit state
  const s0 = newEditState(URI);
  const s1 = setCaptionEdits(s0, edits);
  let h = pushEdit(emptyHistory(), s0);
  eq("the edit state holds the deleted words", s1.captionEdits, { 3: "", 4: "", 5: "" });
  const u = undoEdit(h, s1);
  eq("undo restores the line", [u.state.captionEdits, buildCaptionLines(talk, u.state.captionEdits ?? {}, whole).length], [undefined, 2]);
  const re = redoEdit(u.history, u.state);
  eq("redo deletes it again", [re.state.captionEdits, canRedo(re.history), canUndo(re.history)], [{ 3: "", 4: "", 5: "" }, false, true]);
  eq("the same edits are not a new undo step", setCaptionEdits(s1, { ...edits }) === s1, true);
  eq("deleting a second line adds to the first", applyLineEdit(talk, edits, lines[0], ""), { 0: "", 1: "", 2: "", 3: "", 4: "", 5: "" });
  eq("the edits survive a switch and a draft save", [setCategoryEnabled(s1, "umCut", false).captionEdits, JSON.parse(JSON.stringify(s1)).captionEdits], [{ 3: "", 4: "", 5: "" }, { 3: "", 4: "", 5: "" }]);
  eq("clearing all edits drops the field", "captionEdits" in setCaptionEdits(s1, {}), false);
}

// ── Post waits for captions ──
{
  const fake = () => { let t = 0; return { sleep: async (ms) => { t += ms; }, now: () => t }; };
  // captions finish after 3 polls
  let polls = 0;
  const waits = [];
  const ok = await settleCaptionsForPost({ captionsOn: true, isBusy: () => ++polls <= 4, onWaiting: (x) => waits.push(x), deps: fake() });
  eq("Post waits while captions are still being made, then posts with them", [ok.captions, ok.note, waits], [true, null, [true, false]]);
  // never finishes: gives up after 10 s of (fake) time
  const deps = fake();
  const slow = await settleCaptionsForPost({ captionsOn: true, isBusy: () => true, onWaiting: () => {}, deps });
  eq("after 10 s it posts without captions and says so", [slow.captions, slow.note, deps.now() >= POST_WAIT_MS && deps.now() < POST_WAIT_MS + 200], [false, "Posted without captions (they were not ready in time)", true]);
  eq("nothing to wait for: posts at once with the captions", await settleCaptionsForPost({ captionsOn: true, isBusy: () => false, deps: fake() }), { action: "post", captions: true, note: null });
  eq("captions off: no waiting, no note", await settleCaptionsForPost({ captionsOn: false, isBusy: () => true, deps: fake() }), { action: "post", captions: false, note: null });
  eq("waitUntil: true when it ends in time, false when it does not", [await waitUntil(() => true, 100, fake()), await waitUntil(() => false, 300, fake())], [true, false]);
  eq("the wait is 10 s", POST_WAIT_MS, 10000);
}

// ── several source files ──
{
  const A = "file:///a.mov";
  const B = "file:///b.mov";
  const aWords = [w("alpha", 1000, 1400), w("beta", 1500, 1900), w("gamma", 4000, 4400), w("delta", 6100, 6500)];
  const bWords = [w("one", 200, 600), w("two", 700, 1100), w("three", 3000, 3400)];
  const { words, wordUris } = combineSources([{ uri: A, words: aWords }, { uri: B, words: bWords }]);
  eq("the words of all files are one list, each remembering its file", [words.length, wordUris], [7, [A, A, A, A, B, B, B]]);
  eq("distinct sources in order of first use", distinctSources([{ uri: A }, { uri: B }, { uri: A }]), [A, B]);
  // timeline: A 500-2000 (1500 ms), B 0-1500 (1500 ms), A 3900-4600 (700 ms)
  const clips = [{ uri: A, startMs: 500, endMs: 2000 }, { uri: B, startMs: 0, endMs: 1500 }, { uri: A, startMs: 3900, endMs: 4600 }];
  const mapped = mapWordsToClips(words.map((x, i) => ({ ...x, uri: wordUris[i] })), clips);
  eq("words land on the combined timeline in order (each file's words shifted by the clips before)", mapped.map((x) => [x.text, x.startMs, x.endMs]), [
    ["alpha", 500, 900], ["beta", 1000, 1400], ["one", 1700, 2100], ["two", 2200, 2600], ["gamma", 3100, 3500],
  ]);
  eq("words in cut-away parts are dropped (delta, three)", mapped.map((x) => x.text).includes("delta") || mapped.map((x) => x.text).includes("three"), false);
  eq("a word only counts in the clips of ITS file (an A word at B's times is not mapped)", mapWordsToClips([{ ...w("x", 100, 500), uri: A }], [{ uri: B, startMs: 0, endMs: 1000 }]), []);
  eq("a word straddling a cut keeps if at least half is in the clip, clamped to its edges", mapWordsToClips([{ ...w("edge", 1800, 2200), uri: A }], [{ uri: A, startMs: 500, endMs: 2000 }]).map((x) => [x.startMs, x.endMs]), [[1300, 1500]]);
  eq("a word mostly cut away is dropped", mapWordsToClips([{ ...w("most", 1900, 2400), uri: A }], [{ uri: A, startMs: 500, endMs: 2000 }]), []);
  const lines = buildCaptionLines(words, {}, clips, null, { wordUris, clips });
  eq("caption lines are built on the combined timeline from every file", lines.map((l) => l.text), ["alpha beta", "one two", "gamma"]);
  eq("each line knows the (global) source words it came from", lines.map((l) => l.srcIndexes), [[0, 1], [4, 5], [2]]);
  eq("line times are on the combined timeline", lines.map((l) => [l.startMs, l.endMs]), [[500, 1400], [1700, 2600], [3100, 3500]]);
  const del = applyLineEdit(words, {}, lines[1], "");
  eq("Delete line works across files (global word indexes)", [del, buildCaptionLines(words, del, clips, null, { wordUris, clips }).map((l) => l.text)], [{ 4: "", 5: "" }, ["alpha beta", "gamma"]]);
  eq("one file: the multi mapping equals the single-file mapping", JSON.stringify(buildCaptionLines(aWords, {}, [{ startMs: 500, endMs: 2000 }])) === JSON.stringify(buildCaptionLines(aWords, {}, [{ startMs: 500, endMs: 2000 }], null, { wordUris: aWords.map(() => A), clips: [{ uri: A, startMs: 500, endMs: 2000 }] })), true);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
