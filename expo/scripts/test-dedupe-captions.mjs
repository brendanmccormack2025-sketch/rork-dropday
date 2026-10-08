#!/usr/bin/env node
/**
 * Duplicate words from recognizer restarts, and caption lines that must fit the box.
 *
 *   node --experimental-strip-types scripts/test-dedupe-captions.mjs
 */
import { dedupeWords, soundShare } from "../lib/transcription/dedupeWords.ts";
import { createAnalysisCache } from "../lib/autoEdit/analysisCache.ts";
import { buildCaptionLines } from "../lib/transcription/captionLines.ts";
import { availableTextWidth, estimateTextWidth, lineFits } from "../lib/transcription/captionFit.ts";
import { resolveOverlayStyle } from "../lib/editStyles.ts";
import { formatAiDebug } from "../lib/autoEdit/debugText.ts";
import { keepRangesToClips } from "../lib/editModel.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const w = (text, startMs, endMs, confidence) => ({ text, startMs, endMs, ...(confidence === undefined ? {} : { confidence }) });
const texts = (words) => words.map((x) => x.text);

/** 20 ms windows over totalMs: -25 dB inside the [from, to) speech spans, -80 elsewhere. */
const loud = (totalMs, spans) => ({
  durationMs: totalMs,
  windows: Array.from({ length: totalMs / 20 }, (_, i) => (spans.some(([a, b]) => i * 20 >= a && i * 20 < b) ? -25 : -80)),
});

// ── repeats ──
// a 5-word opening phrase and, 40 s later, the same words with the same timing (a restart artifact)
const OPENING = [w("SO", 300, 500), w("I", 500, 650), w("HAVE", 650, 900), w("TO", 900, 1100), w("GO", 1150, 1350)];
const COPY = (at) => [w("SO", at, at + 200), w("I", at + 200, at + 350), w("HAVE", at + 350, at + 600), w("TO", at + 600, at + 800), w("GO", at + 850, at + 1050)];
const MIDDLE = [w("get", 1500, 1800), w("up", 1800, 2000), w("my", 2000, 2200), w("lease", 2200, 2600), w("body", 2700, 3100)];
const SPEECH = loud(48800, [[300, 3200]]);
{
  const withRepeat = [...OPENING, ...MIDDLE, ...COPY(40000)];
  const r = dedupeWords(withRepeat, SPEECH);
  eq("a 5-word restart artifact with identical timing (in silence) is removed", texts(r.words), ["SO", "I", "HAVE", "TO", "GO", "get", "up", "my", "lease", "body"]);
  eq("...and counted, with the removed words listed", [r.report.repeatedWords, r.report.overlappingWords, texts(r.report.words)], [5, 0, ["SO", "I", "HAVE", "TO", "GO"]]);
  eq("the copy at the start keeps its times", r.words[0].startMs, 300);
  eq("the decision is reported with its reason", [r.report.decisions.length, r.report.decisions[0].outcome, r.report.decisions[0].reason.startsWith("restart artifact: same timing")], [1, "removed", true]);

  // the later copy is the one on sound and the earlier one (in silence) is dropped instead
  const lateSpeech = loud(48800, [[40000, 41500]]);
  const r2 = dedupeWords(withRepeat, lateSpeech);
  eq("the copy that lands on sound is the one kept", [r2.words.length, r2.words[r2.words.length - 1].startMs, r2.words[0].text], [10, 40850, "get"]);

  eq("without loudness data nothing can be verified: both copies stay", [dedupeWords(withRepeat, null).words.length, dedupeWords(withRepeat, null).report.decisions[0].outcome], [15, "kept"]);

  // REAL repeated phrases survive
  const IDK = (at) => [w("I", at, at + 250), w("don't", at + 300, at + 600), w("know", at + 650, at + 1000)];
  const idk = [...IDK(12000), w("How", 13300, 13600), w("I'm", 13700, 13900), w("gonna", 13950, 14300), w("pay", 14350, 14600), w("this", 14650, 14850), w("lease", 14900, 15400), ...IDK(43000)];
  const idkLoud = loud(48800, [[12000, 15400], [43000, 44000]]);
  const ri = dedupeWords(idk, idkLoud);
  eq("\"I don't know\" said twice at different times: both copies kept", [texts(ri.words).filter((x) => x === "know").length, ri.report.repeatedWords], [2, 0]);
  eq("...and the decision says why (a run of 3 words)", ri.report.decisions.map((d) => [d.outcome, d.reason.includes("a run of 3 words")]), [["kept", true]]);
  const FIVE = (at, gaps) => { let t = at; return ["you", "know", "what", "I", "mean"].map((x, i) => { const o = w(x, t, t + 200); t += 200 + gaps[i]; return o; }); };
  const diff = [...FIVE(1000, [100, 100, 100, 100, 0]), ...MIDDLE.map((x) => ({ ...x, startMs: x.startMs + 3000, endMs: x.endMs + 3000 })), ...FIVE(30000, [100, 300, 100, 100, 0])];
  const rd = dedupeWords(diff, loud(48800, [[1000, 6000], [30000, 31500]]));
  eq("a real 5-word phrase said twice with different timing: both kept", [rd.report.repeatedWords, texts(rd.words).filter((x) => x === "mean").length, rd.report.decisions[0].reason.startsWith("timing differs")], [0, 2, true]);
  const same = [...OPENING, ...MIDDLE, ...COPY(40000)];
  const rs = dedupeWords(same, loud(48800, [[300, 3200], [40000, 41500]]));
  eq("identical timing but BOTH copies on speech-level audio with nothing else over them: both kept", [rs.report.repeatedWords, rs.words.length, rs.report.decisions[0].reason.includes("real repeated phrase")], [0, 15, true]);
  // other words cover the dropped copy: the artifact overlaps real speech, so it can go
  const covered = [...OPENING, ...MIDDLE, ...COPY(40000), w("announcement", 39900, 41100)];
  const rc = dedupeWords(covered, loud(48800, [[300, 3200], [40000, 41500]]));
  eq("a copy sitting on audio that another word covers is removed", rc.report.repeatedWords, 5);

  eq("a run of only two matching words is not a repeat", texts(dedupeWords([w("so", 0, 200), w("i", 200, 400), w("go", 600, 800), w("so", 2000, 2200), w("i", 2200, 2400)], null).words).length, 5);
  const ci = dedupeWords([w("So,", 0, 200), w("I", 200, 400), w("have", 400, 600), w("to", 600, 800), w("go", 850, 1050), w("then", 2000, 2300), w("so", 5000, 5200), w("i.", 5200, 5400), w("HAVE", 5400, 5600), w("To!", 5600, 5800), w("go", 5850, 6050)], loud(48800, [[0, 2400]]));
  eq("text is compared ignoring case and punctuation", [ci.report.repeatedWords, ci.report.decisions[0].outcome], [5, "removed"]);
}

// ── overlaps ──
{
  const copies = [w("get", 1000, 1300, 0.9), w("up", 1300, 1600, 0.4), w("up", 1320, 1620, 0.8), w("my", 1650, 1900, 0.7)];
  const r = dedupeWords(copies, null);
  eq("two overlapping copies: the higher-confidence one is kept", [texts(r.words), r.words[1].confidence], [["get", "up", "my"], 0.8]);
  eq("...and counted", r.report.overlappingWords, 1);
  const other = dedupeWords([w("lease", 1000, 1400, 0.3), w("I", 1100, 1500, 0.6)], null);
  eq("overlap decides by time, not text", texts(other.words), ["I"]);
  eq("a small overlap (under half) keeps both", texts(dedupeWords([w("a", 0, 400), w("b", 300, 700)], null).words), ["a", "b"]);
}

// ── normal speech is untouched ──
{
  const speech = [w("so", 0, 200), w("this", 300, 500), w("is", 500, 650), w("very", 700, 900), w("very", 950, 1150), w("good", 1200, 1500), w("and", 1600, 1750), w("the", 1750, 1900), w("clip", 1900, 2200)];
  const r = dedupeWords(speech, null);
  eq("normal speech (with a stutter) is unchanged", [r.words, r.report.repeatedWords, r.report.overlappingWords], [speech, 0, 0]);
  eq("an empty transcript is fine", dedupeWords([], null).words, []);
  eq("soundShare: all speech / all silence", [soundShare(SPEECH, 500, 1500), soundShare(SPEECH, 40000, 40800)], [1, 0]);
}

// ── in the cache: cleaned before it is judged and cached ──
{
  const store = new Map();
  const storage = { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), remove: async (k) => void store.delete(k) };
  let calls = 0;
  const mk = (words) => createAnalysisCache({
    stat: async (uri) => ({ uri, size: 1, mtime: 1 }),
    loadLoudness: async () => SPEECH,
    transcribe: async () => { calls++; return { status: "ok", words }; },
    storage,
  });
  const dup = [...OPENING, ...MIDDLE, ...COPY(40000)];
  const r = await mk(dup).transcriptWithInfo("file:///a.mov");
  eq("the cache returns words without the repeat, with the removed count", [r.result.words.length, [r.result.removed.repeatedWords, r.result.removed.overlappingWords]], [10, [5, 0]]);
  const again = await mk(dup).transcriptWithInfo("file:///a.mov");
  eq("a later run reads the cleaned words and the same count from storage", [again.fromCache, again.result.words.length, again.result.removed.repeatedWords, calls], [true, 10, 5, 1]);

  // a transcript an older build stored was already deduped by the old rules (it may have lost real
  // words): it is not trusted, and the clip is transcribed again
  const old = new Map([["trial:analysis:v1:transcript:file:///b.mov|1|1", JSON.stringify(dup.slice(5, 10))]]);
  let oldCalls = 0;
  const oldCache = createAnalysisCache({
    stat: async (uri) => ({ uri, size: 1, mtime: 1 }),
    loadLoudness: async () => SPEECH,
    transcribe: async () => { oldCalls++; return { status: "ok", words: dup }; },
    storage: { get: async (k) => old.get(k) ?? null, set: async (k, v) => void old.set(k, v), remove: async (k) => void old.delete(k) },
  });
  const o = await oldCache.transcriptWithInfo("file:///b.mov");
  eq("an old stored transcript (no raw words) is transcribed again", [o.fromCache, oldCalls, o.result.words.length], [false, 1, 10]);
  // the raw words are stored, so a rule change needs no new transcription
  const stored = JSON.parse(old.get("trial:analysis:v1:transcript:file:///b.mov|1|1"));
  eq("the new entry keeps the raw words", [stored.raw.length, stored.words.length], [15, 10]);
  const dec = (await mk(dup).transcriptWithInfo("file:///a.mov")).result.removed.decisions;
  eq("the cache result carries the dedupe decisions and the removed words", [dec.length, (await mk(dup).transcriptWithInfo("file:///a.mov")).result.removed.words.length], [1, 5]);
}

// ── captions fit the box ──
{
  const spec = resolveOverlayStyle("caption", "trial");
  const avail = availableTextWidth(spec);
  eq("available width = 0.86 of 1080 minus padding, with margin", Math.round(avail), Math.round((0.86 * 1080 - 36) * 0.92));
  const long = ["EXTRAORDINARILY", "COMMUNICATION", "WONDERFULLY", "UNBELIEVABLE"].map((t, i) => w(t, i * 400, i * 400 + 350, 1));
  const lines = buildCaptionLines(long, {}, [{ startMs: 0, endMs: 5000 }]);
  eq("long words are split into fewer words per line", lines.map((l) => l.text), ["EXTRAORDINARILY", "COMMUNICATION", "WONDERFULLY", "UNBELIEVABLE"]);
  eq("every line fits the available width", lines.every((l) => lineFits(l.text, spec) || !l.text.includes(" ")), true);
  eq("a long phrase is split down to fewer than 3 words per line", Math.max(...lines.map((l) => l.text.split(" ").length)) < 3, true);
  const wide = buildCaptionLines([w("MMMMMMMMMMMMMMMMMMMMMMMMMM", 0, 500, 1)], {}, [{ startMs: 0, endMs: 1000 }]);
  eq("a single word wider than the box stays alone (never dropped)", wide.map((l) => l.text), ["MMMMMMMMMMMMMMMMMMMMMMMMMM"]);
  const short = buildCaptionLines([w("so", 0, 200, 1), w("I", 200, 300, 1), w("have", 300, 500, 1)], {}, [{ startMs: 0, endMs: 1000 }]);
  eq("short words still group three to a line", short.map((l) => l.text), ["so I have"]);
  eq("estimate: more characters are wider", estimateTextWidth("HELLO THERE", spec) > estimateTextWidth("HELLO", spec), true);

  // one caption at a time
  const crowd = [w("a", 0, 300, 1), w("b", 300, 600, 1), w("c", 600, 900, 1), w("d", 800, 1100, 1), w("e", 1100, 1400, 1), w("f", 1400, 1700, 1), w("g", 1700, 2000, 1)];
  const out = buildCaptionLines(crowd, {}, [{ startMs: 0, endMs: 3000 }]);
  eq("caption lines never overlap in time", out.every((l, i) => i === 0 || l.startMs >= out[i - 1].endMs), true);
  eq("every line has a positive duration", out.every((l) => l.endMs > l.startMs), true);
}

// ── debug text ──
{
  const text = formatAiDebug({
    sourceDurationMs: 10000,
    clips: keepRangesToClips("file:///a.mov", [{ startMs: 0, endMs: 10000 }]),
    sourceUri: "file:///a.mov",
    proposals: [],
    candidates: [],
    transcription: { status: "ok", wordCount: 2, repeatedWordsRemoved: 5, overlappingWordsRemoved: 1, dedupeDecisions: [{ outcome: "removed", text: "SO I HAVE TO GO", wordCount: 5, earlierStartMs: 300, laterStartMs: 40000, reason: "restart artifact: same timing" }, { outcome: "kept", text: "I don't know", wordCount: 3, earlierStartMs: 12000, laterStartMs: 43000, reason: "a run of 3 words (a repeat needs at least 5): kept both" }], fromCache: false, key: "k" },
    hookTrims: [],
    fillers: [],
    transcriptWords: [w("SO", 300, 500), w("I", 500, 650)],
  });
  eq("debug text: removed counts", text.includes("Duplicates removed: 5 repeated words, 1 overlapping words"), true);
  eq("debug text: each dedupe decision, kept or removed, with its reason", [text.includes('REMOVED "SO I HAVE TO GO" (5 words at 0:00.3 and 0:40.0): restart artifact'), text.includes('KEPT "I don\'t know" (3 words at 0:12.0 and 0:43.0)')], [true, true]);
  eq("debug text: the word list with times", text.includes("0:00.3-0:00.5  SO") && text.includes("0:00.5-0:00.7  I"), true);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
