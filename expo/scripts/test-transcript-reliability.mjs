#!/usr/bin/env node
/**
 * Transcript reliability: an empty transcript is not trusted when the audio has
 * sound, recognizer errors never become ok + [], and clearing the cache forces a
 * fresh analysis.
 *
 *   node --experimental-strip-types scripts/test-transcript-reliability.mjs
 */
import { createAnalysisCache, EMPTY_TRANSCRIPT_MIN_SOUND_MS, MIN_WORDS_PER_SOUND_SECOND, nonSilentMs } from "../lib/autoEdit/analysisCache.ts";
import { mapTranscribeError, mapTranscription } from "../lib/transcription/map.ts";
import { formatAiDebug } from "../lib/autoEdit/debugText.ts";
import { keepRangesToClips } from "../lib/editModel.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const URI = "file:///a.mov";
const word = (text, startMs, endMs) => ({ text, startMs, endMs });
/** n words, one per second: enough for a clip with 30 s of sound when n >= 15. */
const many = (n) => Array.from({ length: n }, (_, i) => word(`w${i}`, i * 1000, i * 1000 + 300));

/** 20 ms windows: `speechMs` of speech at -25 dB, the rest quiet (-80). */
const loudness = (totalMs, speechMs) => ({
  durationMs: totalMs,
  windows: Array.from({ length: totalMs / 20 }, (_, i) => (i * 20 < speechMs ? -25 : -80)),
});
const SPEECH_CLIP = loudness(48800, 30000);
const SILENT_CLIP = loudness(10000, 0);

function makeCache({ loud, transcribe, storage }) {
  const calls = { loudness: 0, transcribe: 0 };
  const cache = createAnalysisCache({
    stat: async (uri) => ({ uri, size: 1000, mtime: 5 }),
    loadLoudness: async () => { calls.loudness++; return loud; },
    transcribe: async () => { calls.transcribe++; return transcribe(); },
    storage: storage ?? undefined,
  });
  return { cache, calls };
}
function memoryStorage() {
  const store = new Map();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    remove: async (k) => void store.delete(k),
  };
}

// ── how much sound ──
eq("non-silent time of a clip with 30 s of speech", Math.round(nonSilentMs(SPEECH_CLIP) / 1000), 30);
eq("a silent clip has none", nonSilentMs(SILENT_CLIP), 0);
eq("no loudness data counts as no sound", nonSilentMs(null), 0);
eq("the threshold is 2 s", EMPTY_TRANSCRIPT_MIN_SOUND_MS, 2000);

// ── an empty transcript with speech-level loudness is not cached ──
{
  const storage = memoryStorage();
  let n = 0;
  const { cache, calls } = makeCache({ loud: SPEECH_CLIP, storage, transcribe: async () => (++n < 3 ? { status: "ok", words: [] } : { status: "ok", words: many(20) }) });
  const first = await cache.transcriptWithInfo(URI);
  eq("ok + [] with 30 s of sound becomes an error", [first.result.status, first.result.code, first.fromCache], ["error", "EMPTY_TRANSCRIPT_WITH_SPEECH", false]);
  eq("...and nothing is stored", [...storage.store.keys()].filter((k) => k.includes("transcript:")), []);
  const second = await cache.transcriptWithInfo(URI);
  eq("it is retried next time (the recognizer runs again)", [second.result.status, calls.transcribe], ["error", 2]);
  const third = await cache.transcriptWithInfo(URI);
  eq("a later good transcript is used and cached", [third.result.status, third.result.words.length, third.fromCache], ["ok", 20, false]);
  const fourth = await cache.transcriptWithInfo(URI);
  eq("...then reused from the cache", [fourth.result.words.length, fourth.fromCache, calls.transcribe], [20, true, 3]);
  eq("the cache key is reported", fourth.key, `${URI}|1000|5`);
}
// ── a sparse transcript (fewer words than half the seconds of sound) is not trusted ──
{
  const words = (n) => Array.from({ length: n }, (_, i) => word(`w${i}`, i * 1000, i * 1000 + 300));
  eq("the rule: fewer than 1 word per 2 s of sound", MIN_WORDS_PER_SOUND_SECOND, 0.5);

  const storage = memoryStorage();
  let n = 0;
  const { cache, calls } = makeCache({ loud: SPEECH_CLIP, storage, transcribe: async () => ({ status: "ok", words: words(++n < 3 ? 4 : 20) }) });
  const first = await cache.transcriptWithInfo(URI);
  eq("4 words for 30 s of sound -> SPARSE_TRANSCRIPT_WITH_SPEECH", [first.result.status, first.result.code, first.fromCache], ["error", "SPARSE_TRANSCRIPT_WITH_SPEECH", false]);
  eq("the message says how sparse it is", first.result.message.startsWith("only 4 words for 30.0 s of sound"), true);
  eq("...and it is not stored", [...storage.store.keys()].filter((k) => k.includes("transcript:")), []);
  const second = await cache.transcriptWithInfo(URI);
  eq("it is retried next time", [second.result.code, calls.transcribe], ["SPARSE_TRANSCRIPT_WITH_SPEECH", 2]);
  const third = await cache.transcriptWithInfo(URI);
  eq("20 words for 30 s of sound is fine and cached", [third.result.status, third.result.words.length, third.fromCache], ["ok", 20, false]);
  const fourth = await cache.transcriptWithInfo(URI);
  eq("...then reused", [fourth.fromCache, calls.transcribe], [true, 3]);

  const exact = makeCache({ loud: SPEECH_CLIP, transcribe: async () => ({ status: "ok", words: words(15) }) });
  eq("exactly sound-seconds / 2 words (15 for 30 s) is accepted", (await exact.cache.transcript(URI)).status, "ok");
  const justUnder = makeCache({ loud: SPEECH_CLIP, transcribe: async () => ({ status: "ok", words: words(14) }) });
  eq("one word fewer (14 for 30 s) is sparse", (await justUnder.cache.transcript(URI)).code, "SPARSE_TRANSCRIPT_WITH_SPEECH");

  const short = makeCache({ loud: loudness(10000, 3000), transcribe: async () => ({ status: "ok", words: words(1) }) });
  eq("1 word for 3 s of sound is below 1.5: sparse", (await short.cache.transcript(URI)).code, "SPARSE_TRANSCRIPT_WITH_SPEECH");
  const shortOk = makeCache({ loud: loudness(10000, 3000), transcribe: async () => ({ status: "ok", words: words(2) }) });
  eq("2 words for 3 s of sound is accepted", (await shortOk.cache.transcript(URI)).status, "ok");
  const quiet = makeCache({ loud: SILENT_CLIP, transcribe: async () => ({ status: "ok", words: words(1) }) });
  eq("a silent clip with one stray word is accepted", (await quiet.cache.transcript(URI)).status, "ok");

  // a sparse transcript cached earlier is dropped for a clip with speech
  const old = memoryStorage();
  old.store.set(`trial:analysis:v1:transcript:${URI}|1000|5`, JSON.stringify(words(3)));
  const redo = makeCache({ loud: SPEECH_CLIP, storage: old, transcribe: async () => ({ status: "ok", words: words(25) }) });
  const r = await redo.cache.transcriptWithInfo(URI);
  eq("a stale sparse transcript in storage is dropped and redone", [r.result.words.length, r.fromCache, redo.calls.transcribe], [25, false, 1]);

  // the empty rule is unchanged
  const empty = makeCache({ loud: SPEECH_CLIP, transcribe: async () => ({ status: "ok", words: [] }) });
  eq("the empty-transcript rule still applies", (await empty.cache.transcript(URI)).code, "EMPTY_TRANSCRIPT_WITH_SPEECH");

  // the code reaches the debug text
  const clips = keepRangesToClips(URI, [{ startMs: 0, endMs: 10000 }]);
  const text = formatAiDebug({ sourceDurationMs: 10000, clips, sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [], transcription: { status: "error", code: first.result.code, message: first.result.message, wordCount: 0, fromCache: false, key: first.key } });
  eq("the debug text shows the SPARSE code", text.split("\n")[1].startsWith("Transcription: error (SPARSE_TRANSCRIPT_WITH_SPEECH: only 4 words for 30.0 s of sound"), true);
}

// ── a genuinely silent clip may be cached empty ──
{
  const { cache, calls } = makeCache({ loud: SILENT_CLIP, storage: memoryStorage(), transcribe: async () => ({ status: "ok", words: [] }) });
  const a = await cache.transcriptWithInfo(URI);
  const b = await cache.transcriptWithInfo(URI);
  eq("a silent clip: ok + [] is believed, cached and reused", [a.result.status, b.result.status, b.fromCache, calls.transcribe], ["ok", "ok", true, 1]);
}
// ── an empty transcript stored earlier (older build) is not trusted for a clip with speech ──
{
  const storage = memoryStorage();
  storage.store.set(`trial:analysis:v1:transcript:${URI}|1000|5`, "[]");
  const { cache, calls } = makeCache({ loud: SPEECH_CLIP, storage, transcribe: async () => ({ status: "ok", words: many(20) }) });
  const r = await cache.transcriptWithInfo(URI);
  eq("a stale empty transcript is dropped and the clip is transcribed again", [r.result.status, r.result.words.length, r.fromCache, calls.transcribe], ["ok", 20, false, 1]);
  eq("the new transcript replaced it in storage", JSON.parse(storage.store.get(`trial:analysis:v1:transcript:${URI}|1000|5`)).words, many(20));
}
// ── other results are untouched ──
{
  const { cache, calls } = makeCache({ loud: SPEECH_CLIP, transcribe: async () => ({ status: "error", code: "ERR_SPEECH_TIMEOUT", message: "recognition timed out" }) });
  const a = await cache.transcriptWithInfo(URI);
  const b = await cache.transcriptWithInfo(URI);
  eq("errors keep their code and are never cached", [a.result.status, a.result.code, b.fromCache, calls.transcribe], ["error", "ERR_SPEECH_TIMEOUT", false, 2]);
}

// ── recognizer errors map to error with the native code, never ok + [] ──
{
  const e = Object.assign(new Error("Recognition request failed"), { code: "ERR_SPEECH_RECOGNITION_FAILED" });
  eq("a recognizer error -> error with the native code", mapTranscribeError(e), { status: "error", code: "ERR_SPEECH_RECOGNITION_FAILED", message: "Recognition request failed" });
  eq("a timeout -> error with its code", mapTranscribeError(Object.assign(new Error("recognition timed out"), { code: "ERR_SPEECH_TIMEOUT" })).code, "ERR_SPEECH_TIMEOUT");
  eq("an export failure -> error", mapTranscribeError(Object.assign(new Error("x"), { code: "ERR_SPEECH_EXPORT_FAILED" })).status, "error");
  eq("a read failure -> error", mapTranscribeError(Object.assign(new Error("x"), { code: "ERR_SPEECH_READ_FAILED" })).status, "error");
  eq("an error with no code -> error with a placeholder code", mapTranscribeError(new Error("boom")), { status: "error", code: "ERR_SPEECH_UNKNOWN", message: "boom" });
  eq("a non-error throw -> error", mapTranscribeError("weird").status, "error");
  eq("no permission -> denied (with the code)", mapTranscribeError(Object.assign(new Error("x"), { code: "ERR_SPEECH_NOT_AUTHORIZED" })), { status: "denied", code: "ERR_SPEECH_NOT_AUTHORIZED", message: "x" });
  eq("no on-device model -> unavailable (with the code)", mapTranscribeError(Object.assign(new Error("x"), { code: "ERR_SPEECH_ON_DEVICE_UNAVAILABLE" })).status, "unavailable");
  eq("no speech detected in audio with sound -> error with its own code", mapTranscribeError(Object.assign(new Error("the recognizer heard no speech in audio that has sound"), { code: "ERR_SPEECH_NO_SPEECH_DETECTED" })), { status: "error", code: "ERR_SPEECH_NO_SPEECH_DETECTED", message: "the recognizer heard no speech in audio that has sound" });
  for (const code of ["ERR_SPEECH_RECOGNITION_FAILED", "ERR_SPEECH_TIMEOUT", "ERR_SPEECH_FAILED", "ERR_SPEECH_BAD_ARGUMENT", "ERR_SPEECH_FILE_NOT_FOUND"]) {
    eq(`${code} is never an empty ok`, mapTranscribeError(Object.assign(new Error("x"), { code })).status !== "ok", true);
  }
  eq("a file without an audio track is ok + []", mapTranscription(null), { status: "ok", words: [] });
  eq("words are carried over; zero confidence is dropped", mapTranscription({ onDevice: true, words: [{ text: "hi", startMs: 0, endMs: 100, confidence: 0 }, { text: "yo", startMs: 100, endMs: 200, confidence: 0.8 }] }).words.map((w) => w.confidence), [undefined, 0.8]);
  eq("server recognition would be unavailable", mapTranscription({ onDevice: false, words: [] }).status, "unavailable");
}

// ── clearing the cache forces re-analysis ──
{
  const storage = memoryStorage();
  const { cache, calls } = makeCache({ loud: SPEECH_CLIP, storage, transcribe: async () => ({ status: "ok", words: many(20) }) });
  await cache.loudness(URI);
  await cache.transcript(URI);
  await cache.transcript(URI);
  await cache.loudness(URI);
  eq("cached: each analysis ran once", [calls.loudness, calls.transcribe], [1, 1]);
  const key = await cache.clear(URI);
  eq("clear returns the key it cleared", key, `${URI}|1000|5`);
  eq("clear removes the stored copies", [...storage.store.keys()].filter((k) => k.includes(URI)), []);
  await cache.loudness(URI);
  const again = await cache.transcriptWithInfo(URI);
  eq("after clear, loudness and transcript are analysed again", [calls.loudness, calls.transcribe, again.fromCache], [2, 2, false]);
  const other = makeCache({ loud: SPEECH_CLIP, storage, transcribe: async () => ({ status: "ok", words: many(20) }) });
  await other.cache.transcript("file:///other.mov");
  await cache.clear(URI);
  eq("clearing one clip leaves another clip's cache alone", [...storage.store.keys()].some((k) => k.includes("other.mov")), true);
}

// ── debug text: transcription status at the top ──
{
  const clips = keepRangesToClips(URI, [{ startMs: 0, endMs: 10000 }]);
  const base = { sourceDurationMs: 10000, clips, sourceUri: URI, proposals: [], candidates: [], hookTrims: [], fillers: [] };
  const top = (transcription) => formatAiDebug({ ...base, transcription }).split("\n").slice(0, 3);
  eq("ok, from the cache", top({ status: "ok", wordCount: 41, fromCache: true, key: `${URI}|1000|5` }), ["Trial AI debug", "Transcription: ok; 41 words; from cache: yes", `Cache key: ${URI}|1000|5`]);
  eq("an error shows its code and reason", top({ status: "error", code: "EMPTY_TRANSCRIPT_WITH_SPEECH", message: "no words", wordCount: 0, fromCache: false, key: "k" })[1], "Transcription: error (EMPTY_TRANSCRIPT_WITH_SPEECH: no words); 0 words; from cache: no");
  eq("denied and unavailable", [top({ status: "denied", code: "ERR_SPEECH_NOT_AUTHORIZED", wordCount: 0, fromCache: false, key: null })[1], top({ status: "unavailable", code: "NOT_IN_BUILD", message: "speech-captions not in this build", wordCount: 0, fromCache: false, key: null })[1]], [
    "Transcription: denied (ERR_SPEECH_NOT_AUTHORIZED); 0 words; from cache: no",
    "Transcription: unavailable (NOT_IN_BUILD: speech-captions not in this build); 0 words; from cache: no",
  ]);
  eq("skipped", top({ status: "skipped", message: "the creator chose Not now", wordCount: 0, fromCache: false, key: null }).slice(1), ["Transcription: skipped (no code: the creator chose Not now); 0 words; from cache: no", "Cache key: none (file could not be read)"]);
  eq("not run", formatAiDebug({ ...base, transcription: null }).split("\n")[1], "Transcription: not run");
  eq("the alignment line follows", formatAiDebug({ ...base, transcription: { status: "ok", wordCount: 1, fromCache: false, key: "k" }, alignment: null }).split("\n")[3], "Timeline check: unavailable (no transcript words)");
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll tests passed");
