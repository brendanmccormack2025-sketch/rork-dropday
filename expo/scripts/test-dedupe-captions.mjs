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
const OPENING = [w("SO", 300, 500), w("I", 500, 650), w("HAVE", 650, 900), w("TO", 900, 1100)];
const MIDDLE = [w("get", 1300, 1600), w("up", 1600, 1800), w("my", 1800, 2000), w("lease", 2000, 2400), w("body", 2500, 2900)];
const SPEECH = loud(48800, [[300, 3000]]);
{
  const withRepeat = [...OPENING, ...MIDDLE, w("SO", 40000, 40200), w("I", 40200, 40350), w("HAVE", 40350, 40600), w("TO", 40600, 40800)];
  const r = dedupeWords(withRepeat, SPEECH);
  eq("the opening phrase appended at the end (in silence) is removed", texts(r.words), ["SO", "I", "HAVE", "TO", "get", "up", "my", "lease", "body"]);
  eq("...and counted", r.report, { repeatedWords: 4, overlappingWords: 0 });
  eq("the copy at the start keeps its times", r.words[0].startMs, 300);

  // the repeat is the one on speech: the earlier copy (in silence) is dropped instead
  const lateSpeech = loud(48800, [[40000, 41500]]);
  const r2 = dedupeWords([...OPENING, ...MIDDLE, w("SO", 40000, 40200), w("I", 40200, 40350), w("HAVE", 40350, 40600), w("TO", 40600, 40800)], lateSpeech);
  eq("the copy that lands on sound is the one kept", [r2.words.length, r2.words[r2.words.length - 1].startMs, r2.words[0].text], [9, 40600, "get"]);

  eq("a tie keeps the earlier copy", texts(dedupeWords(withRepeat, null).words).slice(0, 4), ["SO", "I", "HAVE", "TO"]);
  eq("a run of only two matching words is not a repeat", texts(dedupeWords([w("so", 0, 200), w("i", 200, 400), w("go", 600, 800), w("so", 2000, 2200), w("i", 2200, 2400)], null).words).length, 5);
  eq("text is compared ignoring case and punctuation", dedupeWords([w("So,", 0, 200), w("I", 200, 400), w("have", 400, 600), w("go", 900, 1100), w("so", 5000, 5200), w("i.", 5200, 5400), w("HAVE", 5400, 5600)], null).report.repeatedWords, 3);
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
  eq("normal speech (with a stutter) is unchanged", [r.words, r.report], [speech, { repeatedWords: 0, overlappingWords: 0 }]);
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
  const dup = [...OPENING, ...MIDDLE, w("SO", 40000, 40200), w("I", 40200, 40350), w("HAVE", 40350, 40600), w("TO", 40600, 40800)];
  const r = await mk(dup).transcriptWithInfo("file:///a.mov");
  eq("the cache returns words without the repeat, with the removed count", [r.result.words.length, r.result.removed], [9, { repeatedWords: 4, overlappingWords: 0 }]);
  const again = await mk(dup).transcriptWithInfo("file:///a.mov");
  eq("a later run reads the cleaned words and the same count from storage", [again.fromCache, again.result.words.length, again.result.removed.repeatedWords, calls], [true, 9, 4, 1]);

  // a transcript an older build stored with the repeat in it is cleaned on read
  const old = new Map([["trial:analysis:v1:transcript:file:///b.mov|1|1", JSON.stringify(dup)]]);
  const oldCache = createAnalysisCache({
    stat: async (uri) => ({ uri, size: 1, mtime: 1 }),
    loadLoudness: async () => SPEECH,
    transcribe: async () => { throw new Error("should not transcribe"); },
    storage: { get: async (k) => old.get(k) ?? null, set: async () => {}, remove: async (k) => void old.delete(k) },
  });
  const o = await oldCache.transcriptWithInfo("file:///b.mov");
  eq("an old stored transcript with a repeat is cleaned when read", [o.fromCache, o.result.words.length, o.result.removed.repeatedWords], [true, 9, 4]);
}

// ── captions fit the box ──
{
  const spec = resolveOverlayStyle("caption", "trial");
  const avail = availableTextWidth(spec);
  eq("available width = 0.86 of 1080 minus padding, with margin", Math.round(avail), Math.round((0.86 * 1080 - 28) * 0.92));
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
    transcription: { status: "ok", wordCount: 2, repeatedWordsRemoved: 4, overlappingWordsRemoved: 1, fromCache: false, key: "k" },
    hookTrims: [],
    fillers: [],
    transcriptWords: [w("SO", 300, 500), w("I", 500, 650)],
  });
  eq("debug text: removed counts", text.includes("Duplicates removed: 4 repeated words, 1 overlapping words"), true);
  eq("debug text: the word list with times", text.includes("0:00.3-0:00.5  SO") && text.includes("0:00.5-0:00.7  I"), true);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
