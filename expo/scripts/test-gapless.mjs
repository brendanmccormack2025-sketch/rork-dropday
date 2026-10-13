#!/usr/bin/env node
/**
 * Gapless preview playback: the A/B scheduling math (which piece, when to start the standby, when to swap, where the
 * next seek goes), the edited <-> source time across swaps, replay, the rendered-file fallback and its cancelling.
 *   node --experimental-strip-types --no-warnings scripts/test-gapless.mjs
 */
import { readFileSync } from "node:fs";
import {
  GAPLESS_DEFAULTS, endState, formatClock, gaplessTick, learnLatency, playPressed, previewSourceFor, replayState, runEndIndex, standbyStartAt, standbyTarget,
} from "../lib/autoEdit/gaplessPlan.ts";
import { buildSegments, editedFromPlayer, editedToSource, sourceToEdited, totalEditedMs } from "../lib/autoEdit/virtualTimeline.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const clips = [
  { id: "a", trimStartMs: 0, trimEndMs: 2000 },
  { id: "b", trimStartMs: 5000, trimEndMs: 6500 },
  { id: "c", trimStartMs: 6500, trimEndMs: 8000 },   // a split: continues where b ends
  { id: "d", trimStartMs: 9000, trimEndMs: 10_000 },
];
const segs = buildSegments(clips);
const D = GAPLESS_DEFAULTS;

// ── scheduling math ──
{
  eq("a split is no gap: pieces that continue form one run", [runEndIndex(segs, 0), runEndIndex(segs, 1), runEndIndex(segs, 2), runEndIndex(segs, 3)], [0, 2, 2, 3]);
  eq("the standby is parked a pre-roll BEFORE the next piece's start (on the piece after the run)", standbyTarget(segs, 0), { index: 1, prepMs: 5000 - D.prerollMs, startMs: 5000 });
  eq("...from inside a run the next piece is the one after the run's end", standbyTarget(segs, 1), { index: 3, prepMs: 9000 - D.prerollMs, startMs: 9000 });
  eq("the last piece has no standby", standbyTarget(segs, 3), null);
  eq("a piece near the start of the file parks at 0, not before it", standbyTarget(buildSegments([{ trimStartMs: 0, trimEndMs: 500 }, { trimStartMs: 60, trimEndMs: 900 }]), 0).prepMs, 0);
  eq("the standby is started pre-roll + start-up latency before the active piece ends", standbyStartAt(2000), 2000 - D.prerollMs - D.latencyMs);

  const tick = (o) => gaplessTick({ segs, activeIndex: 0, aMs: 100, bMs: 0, standby: null, nowMs: 1000, playing: true, heldMs: 0, ...o });
  const parked = { index: 1, prepMs: 5000 - D.prerollMs, preparedAt: 0, playing: false, ready: true };
  eq("no standby yet: park it", tick({}), { kind: "prepare", toIndex: 1, seekMs: 4880 });
  eq("parked, far from the end: nothing to do", tick({ standby: parked }), { kind: "none" });
  eq("parked but not ready: not started", tick({ aMs: 1900, standby: { ...parked, ready: false } }), { kind: "none" });
  eq("parked and due: start it (muted, hidden)", tick({ aMs: standbyStartAt(2000), standby: parked }), { kind: "startStandby" });
  eq("a stale standby (parked for another piece or place) is parked again", tick({ standby: { ...parked, prepMs: 100 } }).kind, "prepare");
  const running = { ...parked, playing: true };
  eq("at the end of the piece, with the standby at the next piece's start: swap", tick({ aMs: 2000 - D.swapLeadMs, bMs: 5000, standby: running }), { kind: "swap", toIndex: 1, editedMs: 2000 });
  eq("...a few ms short of it still counts as arrived", tick({ aMs: 1990, bMs: 5000 - D.arriveTolMs + 1, standby: running }).kind, "swap");
  eq("the standby late: the active player waits (holds) at the end of its piece", tick({ aMs: 1990, bMs: 4950, standby: running }), { kind: "hold" });
  eq("...but not forever: after the hold limit it hops over the cut itself", tick({ aMs: 1990, bMs: 4950, standby: running, heldMs: D.holdMaxMs }), { kind: "hop", toIndex: 1, seekToSourceMs: 5000, editedMs: 2000, reason: "hold-limit" });
  eq("a standby that would arrive too late to be worth waiting for: hop at once (a wait would cost as much as the seek)", tick({ aMs: 1990, bMs: 4700, standby: running }), { kind: "hop", toIndex: 1, seekToSourceMs: 5000, editedMs: 2000, reason: "standby-too-late" });
  eq("a standby that was never started: hop", tick({ aMs: 1990, standby: parked }).reason, "standby-not-started");
  eq("no standby when it is due (a very short piece): hop", tick({ aMs: 1990 }), { kind: "hop", toIndex: 1, seekToSourceMs: 5000, editedMs: 2000, reason: "no-standby" });
  eq("paused: parking happens, swapping never", [tick({ playing: false }).kind, tick({ playing: false, aMs: 1999, bMs: 5000, standby: running }).kind], ["prepare", "none"]);
  eq("inside a split run the playing piece changes with no player action at all", gaplessTick({ segs, activeIndex: 1, aMs: 6600, bMs: 0, standby: null, nowMs: 0, playing: true, heldMs: 0 }), { kind: "advanceWithin", toIndex: 2 });
  eq("the last piece ending ends the edit", gaplessTick({ segs, activeIndex: 3, aMs: 9990, bMs: 0, standby: null, nowMs: 0, playing: true, heldMs: 0 }), { kind: "end", editedMs: segs[3].outEndMs });
  eq("the latency is learned: a late standby starts earlier next time, an early one later", [learnLatency(60, -40), learnLatency(60, 40), learnLatency(60, 0), learnLatency(20, 400), learnLatency(240, -400)], [100, 40, 60, 15, 250]);
}

// ── a whole playback, two simulated players ──
function simulate({ list, trueLatencyMs = 50, fps = 60, startLatency = D.latencyMs }) {
  const table = buildSegments(list);
  const mk = () => ({ pos: 0, playing: false, muted: true, delay: 0 });
  const players = [mk(), mk()];
  const play = (p) => { if (!p.playing) { p.playing = true; p.delay = trueLatencyMs; } };
  let active = 0, activeIndex = 0, standby = null, heldSince = null, latency = startLatency, now = 0;
  players[0].pos = table[0].srcStartMs; players[0].muted = false; play(players[0]); players[0].delay = 0;
  const log = { swaps: 0, hops: 0, holds: 0, activeSeeks: 0, audible: [], edited: [], bothAudible: 0, ended: false, standbyAudible: 0, endedAt: 0 };
  const dt = 1000 / fps;
  for (let frame = 0; frame < 60 * fps && !log.ended; frame++) {
    const A = players[active], B = players[1 - active];
    if (standby?.playing && !B.playing) play(B);
    const ready = !!standby && (standby.playing || (now - standby.preparedAt >= D.readyAfterMs && Math.abs(B.pos - standby.prepMs) < 150));
    const action = gaplessTick({ segs: table, activeIndex, aMs: A.pos, bMs: B.pos, standby: standby ? { ...standby, ready } : null, nowMs: now, playing: true, heldMs: heldSince === null ? 0 : now - heldSince, params: { latencyMs: latency } });
    if (action.kind === "advanceWithin") activeIndex = action.toIndex;
    else if (action.kind === "prepare") { B.playing = false; B.muted = true; B.pos = action.seekMs; standby = { index: action.toIndex, prepMs: action.seekMs, preparedAt: now, playing: false }; }
    else if (action.kind === "startStandby") { B.muted = true; play(B); standby.playing = true; }
    else if (action.kind === "swap") {
      latency = learnLatency(latency, B.pos - table[action.toIndex].srcStartMs - (heldSince === null ? 0 : now - heldSince));
      B.muted = false; A.muted = true; A.playing = false; active = 1 - active; activeIndex = action.toIndex; standby = null; heldSince = null; log.swaps++;
    } else if (action.kind === "hold") { if (heldSince === null) { heldSince = now; log.holds++; } A.playing = false; }
    else if (action.kind === "hop") { if (standby?.playing) B.playing = false; A.pos = action.seekToSourceMs; if (!A.playing) play(A); A.delay = 0; activeIndex = action.toIndex; standby = null; heldSince = null; log.hops++; log.activeSeeks++; }
    else if (action.kind === "end") { log.ended = true; log.endedAt = now; A.playing = false; }
    // time passes
    for (const p of players) { if (p.playing) { if (p.delay > 0) p.delay -= dt; else p.pos += dt; } }
    now += dt;
    const act = players[active], oth = players[1 - active];
    if (!act.muted && act.playing && act.delay <= 0) log.audible.push(act.pos);
    if (!oth.muted) log.standbyAudible++;
    if (!act.muted && !oth.muted) log.bothAudible++;
    log.edited.push(editedFromPlayer(table, activeIndex, act.pos));
  }
  return { log, table };
}
const kept = (table, ms, slack = 40) => table.some((s) => ms >= s.srcStartMs - slack && ms <= s.srcEndMs + slack);
{
  const { log, table } = simulate({ list: clips });
  eq("playing across the cuts: one swap per cut (the split needs none), no hops, no waiting", [log.swaps, log.hops, log.holds, log.ended], [2, 0, 0, true]);
  eq("the playing player never seeks: the cut is a hand-over to the other one", log.activeSeeks, 0);
  ok("nothing that was cut out is ever heard", log.audible.every((ms) => kept(table, ms)));
  eq("only one player is ever audible (no doubled audio at the swap)", [log.bothAudible, log.standbyAudible], [0, 0]);
  ok("the playhead (edited time) only moves forward, with no jump larger than a frame or the swap lead", log.edited.every((v, i) => i === 0 || (v >= log.edited[i - 1] - 1e-6 && v - log.edited[i - 1] <= 17 + D.swapLeadMs)));
  ok("it takes as long as the edit is long (no stalls at the cuts)", Math.abs(log.endedAt - totalEditedMs(table)) < 120);
}
{
  const many = [0, 1, 2, 3, 4].map((i) => ({ id: String(i), trimStartMs: i * 3000, trimEndMs: i * 3000 + 1500 }));
  const slow = simulate({ list: many, trueLatencyMs: 200 });
  ok("a player slower to start than assumed: it waits a moment at first, then the start-up latency is learned and later cuts need no wait", slow.log.holds <= 1 && slow.log.hops === 0 && slow.log.swaps === 4);
  const fast = simulate({ list: many, trueLatencyMs: 5 });
  ok("a faster player works too", fast.log.swaps === 4 && fast.log.hops === 0 && fast.log.audible.every((ms) => kept(fast.table, ms)));
  const short = simulate({ list: [{ id: "a", trimStartMs: 0, trimEndMs: 1000 }, { id: "b", trimStartMs: 2000, trimEndMs: 2090 }, { id: "c", trimStartMs: 3000, trimEndMs: 4000 }] });
  ok("a piece too short to prepare for falls back to the seek over the cut, and still ends", short.log.ended && short.log.audible.every((ms) => kept(short.table, ms, 60)));
}

// ── edited <-> source time across swaps ──
{
    const t = segs;
  eq("the playhead from the active player, piece by piece", [editedFromPlayer(t, 0, 1000), editedFromPlayer(t, 1, 5500), editedFromPlayer(t, 2, 7000), editedFromPlayer(t, 3, 9500)], [1000, 2500, 4000, 5500]);
  eq("it is continuous over a swap (the end of one piece and the start of the next are the same edited time)", [editedFromPlayer(t, 0, 2000), editedFromPlayer(t, 1, 5000)], [2000, 2000]);
  eq("and over a split", [editedFromPlayer(t, 1, 6500), editedFromPlayer(t, 2, 6500)], [3500, 3500]);
  eq("source <-> edited agree for every piece", [0, 1999, 5000, 6499, 6500, 7999, 9000, 9999].map((s) => Math.round(editedToSource(t, sourceToEdited(t, s).editedMs).sourceMs)), [0, 1999, 5000, 6499, 6500, 7999, 9000, 9999]);
}

// ── ending and replay ──
{
  eq("playing to the end stops there and shows replay", endState(5000), { isPlaying: false, ended: true, positionMs: 5000 });
  eq("replay: from 0, playing, no longer ended", replayState(), { isPlaying: true, ended: false, positionMs: 0 });
  eq("the play button: pause while playing, play when paused, replay once the edit has ended", [playPressed({ isPlaying: true, ended: false }), playPressed({ isPlaying: false, ended: false }), playPressed({ isPlaying: false, ended: true })], ["pause", "play", "replay"]);
  eq("replay starts at the first piece's start", editedToSource(segs, replayState().positionMs), { sourceMs: 0, segment: 0 });
  eq("the clock reads edited time", [formatClock(12_400), formatClock(0), formatClock(48_000), formatClock(NaN), formatClock(61_000)], ["0:12", "0:00", "0:48", "0:00", "1:01"]);
}

// ── the rendered file ──
{
  eq("no matching render: the two players play", previewSourceFor({ aheadMatches: false, isPlaying: true, renderedWasPlaying: true }), "players");
  eq("a finished render plays when playback starts on it", [previewSourceFor({ aheadMatches: true, isPlaying: false, renderedWasPlaying: true }), previewSourceFor({ aheadMatches: true, isPlaying: true, renderedWasPlaying: true })], ["rendered", "rendered"]);
  eq("...but is never swapped in the middle of playback", previewSourceFor({ aheadMatches: true, isPlaying: true, renderedWasPlaying: false }), "players");
  eq("an edit makes the render stale at once and the players are back", previewSourceFor({ aheadMatches: false, isPlaying: false, renderedWasPlaying: true }), "players");
  const ahead = read("../lib/renderAhead.ts");
  const edit = read("../app/edit.tsx");
  ok("every change of the timeline cancels the render in flight (update -> invalidate -> cancel) before a new wait starts", /this\.invalidate\(\);\s*this\.setState\(\{ kind: "waiting" \}\)/.test(ahead) && /private invalidate[\s\S]{0,80}this\.inflight\.cancel\(\)/.test(ahead));
  ok("the editor hands every change of the clips to the render-ahead, which starts only after 2 s without an edit", /aheadRef\.current\?\.update\(\{ \.\.\.args, isRoot: args\.isRoot && !noCuts \}\)/.test(edit) && /RENDER_AHEAD_IDLE_MS = 2000/.test(ahead));
  ok("the editor never waits for it: no loading state, play starts on the two players", /const waitForPreview = false/.test(edit));
  ok("a render finishing while playing does not switch players mid-playback", /previewSourceFor\(\{ aheadMatches, isPlaying, renderedWasPlaying: renderedWasPlayingRef\.current \}\)/.test(edit) && /if \(!isPlaying\) renderedWasPlayingRef\.current = aheadMatches/.test(edit));
}

// ── the screens ──
{
  const edit = read("../app/edit.tsx");
  const bar = read("../components/PlaybackControls.tsx");
  ok("two expo-video players on the same source: the second is loaded as the preload slot, parked and swapped by the scheduler", /setPreloadSource\(\(prev\) => \(prev\?\.uri === geUri/.test(edit) && /gaplessTick\(\{/.test(edit) && /case "swap"/.test(edit));
  ok("the swap changes opacity (shared values) and mute only", /slotB\.value = 1;\s*slotA\.value = 0/.test(edit) && /B\.muted = false;\s*A\.muted = true;\s*A\.pause\(\)/.test(edit) && /useAnimatedStyle\(\(\) => \(\{ opacity: slotA\.value \}\)\)/.test(edit));
  ok("the swap is scheduled from the players' own playback times, every frame", /A\.currentTime \* 1000/.test(edit) && /B\.currentTime \* 1000/.test(edit) && /requestAnimationFrame\(tick\)/.test(edit));
  ok("if the scheduler throws, the single-player path takes over", /setGeFailed\(true\)/.test(edit) && /!gaplessOn/.test(edit));
  ok("playing to the end stops (no loop) and shows replay; the status handler of the playing piece never seeks back", /const stopAtEnd = useCallback/.test(edit) && /setPlayEnded\(true\)/.test(edit) && !/Hot swap for the wrap-around/.test(edit) && /playerR\.loop = false/.test(edit));
  ok("Replay restarts from 0 and plays", /const handleReplay[\s\S]{0,700}handleSeek\(own \? own\.outStartMs : 0\);\s*setTimeout\(\(\) => setIsPlaying\(true\), 60\)/.test(edit));
  ok("tapping the video still toggles play/pause (and replays at the end)", /togglePlay\(\)/.test(edit) && /=== "replay"/.test(edit));
  ok("controls under the video on the Cuts screen; the full-screen editor has the slim progress bar with replay and time instead of a second play button", /<PlaybackControls\s+isPlaying=\{isPlaying\}/.test(edit) && /<EditorTransport/.test(edit) && !/<PlaybackControls\s+floating/.test(edit));
  ok("the controls are rounded: play/pause 56 pt circle, replay circle, time pill", /big: \{[^}]*borderRadius: 28/.test(bar) && /small: \{[^}]*borderRadius: 22/.test(bar) && /time: \{[^}]*borderRadius: 18/.test(bar));
  ok("crash-safe: the only reanimated use added is opacity", !/runOnUI|useAnimatedReaction|useFrameCallback|['"]worklet['"]/.test(edit));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
