/**
 * The camera's recording state machine: idle -> recording -> stopping -> idle.
 *
 * One tap starts a TAKE. A take is one or more segments (one recordAsync call each). Nothing restarts by itself:
 * when the take's segment ends, the state is idle again. The only automatic start is after a flip made WHILE
 * recording: the segment is ended, the camera is switched, and the next segment of the SAME take starts the moment
 * the new camera is ready (see flip()). The state stays "recording" through the flip, so the UI never shows a
 * stop. Taps while stopping are ignored; a flip while a flip is switching is ignored.
 *
 * Pure apart from the injected deps (the native camera); erasable TypeScript only so the Node tests can run it.
 */
import { canRecordMore, maxDurationSeconds, remainingMs, type CameraSegment } from "./cameraSegments.ts";

export type RecState = "idle" | "recording" | "stopping";

export type RecordingDeps = {
  /** One native recording of at most `maxDurationSec` seconds; resolves when it ends (stop or limit). */
  record(maxDurationSec: number): Promise<{ uri?: string } | null | undefined>;
  /** Ask the native camera to end the recording in progress. Safe to call more than once. */
  stopNative(): void;
  /** Resolves true when the camera can record (false: it did not become ready in time). */
  ensureReady(): Promise<boolean>;
  /** Switch front/back. */
  switchFacing(): void;
  /**
   * When the next segment may first be tried after a switch: at once if the camera reports ready, otherwise after a
   * short first-try delay. The controller then tries and retries until the camera accepts.
   */
  afterFlipSettled(): Promise<void>;
  /** The segments recorded so far (the 60 s cap is worked out from them). */
  getSegments(): CameraSegment[];
  onSegment(segment: CameraSegment & { uri: string; type: "video" }): void;
  /** Delete a file of a segment that was dropped as empty. */
  discardFile?(uri: string): void;
  onState(state: RecState): void;
  onError(message: string | null): void;
  /** True while a flip is switching cameras (for the blur over the preview). */
  onSwitching?(switching: boolean): void;
  /** A take (tap to start -> tap to stop, flips included) began. */
  onTakeStart?(takeId: string, startedAt: number): void;
  onRunStart?(startedAt: number): void;
  /** Flip handoff measured: the previous segment resolved -> the next recording was accepted by the camera (ms). */
  onFlipGap?(gapMs: number, info: { retries: number }): void;
  now(): number;
  newId(): string;
  delay(ms: number): Promise<void>;
};

export const FULL_TEXT = "That's the 60 seconds. Tap ✓, or delete the last clip to record more.";
export const NOT_READY_TEXT = "Camera not ready. Please try again.";
export const NOT_SAVED_TEXT = "Recording could not be saved. Please try again.";

/** After asking the camera to stop, ask again this often while it is still recording. */
const STOP_RETRY_MS = 300;
const STOP_RETRIES = 6;
/** After a flip: a recording still running this long after it was asked for counts as accepted. */
const ACCEPT_AFTER_MS = 120;
const MAX_START_RETRIES = 15;
const RETRY_SPACING_MS = 50;
/** A segment shorter than this is a failed or accidental start, not footage: it is discarded. */
export const MIN_SEGMENT_MS = 200;
export const CANT_CONTINUE_TEXT = "Couldn't continue after the flip. Tap to record again.";

export class RecordingController {
  state: RecState = "idle";
  private deps: RecordingDeps;
  private stopRequested = false;
  private flipRequested = false;
  private recording = false;
  private running: Promise<void> = Promise.resolve();
  /** Identifies the native recording in progress, so an old cap timer never stops a newer segment. */
  private token = 0;
  private switching = false;
  private takeId = "";
  /** When the last segment resolved (the start of the flip gap). */
  private lastResolvedAt = 0;

  constructor(deps: RecordingDeps) {
    this.deps = deps;
  }

  private set(state: RecState) {
    if (this.state === state) return;
    this.state = state;
    this.deps.onState(state);
  }

  /** Resolves when the current run (and any flip restart) is over. For tests and teardown. */
  settled(): Promise<void> {
    return this.running;
  }

  /** Start a segment. Only from idle; false when ignored or refused. */
  start(): boolean {
    if (this.state !== "idle") return false;
    if (!canRecordMore(this.deps.getSegments())) {
      this.deps.onError(FULL_TEXT);
      return false;
    }
    this.deps.onError(null);
    this.stopRequested = false;
    this.flipRequested = false;
    this.takeId = this.deps.newId();
    this.deps.onTakeStart?.(this.takeId, this.deps.now());
    this.set("recording");
    this.running = this.run();
    return true;
  }

  /** End the segment in progress. Only while recording; ignored while stopping. */
  stop(): boolean {
    if (this.state !== "recording") return false;
    this.stopRequested = true;
    this.set("stopping");
    void this.stopNativeUntilEnded();
    return true;
  }

  /** What a tap on the record button does. */
  toggle(): "started" | "stopped" | "ignored" {
    if (this.state === "idle") return this.start() ? "started" : "ignored";
    if (this.state === "recording") return this.stop() ? "stopped" : "ignored";
    return "ignored";
  }

  /**
   * Flip the camera. Idle: just switch. Recording: end this segment, switch, and start the next segment of the same
   * take the moment the new camera is ready; the state stays "recording" throughout. Ignored while stopping or
   * while a flip is already switching.
   */
  flip(): boolean {
    if (this.state === "stopping" || this.switching || this.flipRequested) return false;
    if (this.state === "idle") {
      this.deps.switchFacing();
      return true;
    }
    this.flipRequested = true;
    void this.stopNativeUntilEnded();
    return true;
  }

  private async stopNativeUntilEnded() {
    if (!this.recording) return; // not recording natively yet: the run sees the request and skips recording
    // Only for THIS native recording: once it has ended (token changes), a later segment is never touched.
    const mine = this.token;
    this.deps.stopNative();
    for (let i = 0; i < STOP_RETRIES && this.recording && this.token === mine; i++) {
      await this.deps.delay(STOP_RETRY_MS);
      if (this.recording && this.token === mine) this.deps.stopNative();
    }
  }

  private async run(): Promise<void> {
    let continuation = false;
    try {
      for (;;) {
        await this.recordOne(continuation);
        if (!this.flipRequested) break;
        // A flip while recording: the segment has ended; switch cameras and start again when the new one is ready.
        this.flipRequested = false;
        this.switching = true;
        this.deps.onSwitching?.(true);
        this.deps.switchFacing();
        await this.deps.afterFlipSettled();
        this.switching = false;
        if (this.stopRequested || !canRecordMore(this.deps.getSegments())) break;
        continuation = true;
      }
    } catch (e) {
      this.deps.onError(e instanceof Error ? e.message : "Recording failed.");
    } finally {
      this.recording = false;
      this.deps.onSwitching?.(false);
      this.set("idle");
    }
  }

  private async recordOne(continuation: boolean): Promise<void> {
    const ready = await this.deps.ensureReady();
    if (!ready) {
      this.deps.onError(NOT_READY_TEXT);
      this.stopRequested = true;
      this.flipRequested = false;
      return;
    }
    // Stopped (or flipped) before the camera even started: nothing was recorded.
    if (this.stopRequested || this.flipRequested) return;
    const segments = this.deps.getSegments();
    const maxSec = maxDurationSeconds(segments);
    let startedAt = this.deps.now();
    this.recording = true;
    const mine = ++this.token;
    // Safety net: the recorder is given the remaining time, but if it does not stop by itself, stop it.
    void this.deps.delay(remainingMs(segments) + 400).then(() => {
      if (this.recording && this.token === mine) this.deps.stopNative();
    });
    let result: { uri?: string } | null | undefined;
    try {
      if (continuation) {
        // The camera may refuse the first try while it is still settling: try again at once (no fixed wait), and
        // call the handoff done when a recording is accepted (still running shortly after it was asked for).
        let retries = 0;
        for (;;) {
          startedAt = this.deps.now();
          const attempt = this.deps.record(maxSec).then(
            (r) => ({ r }),
            (err: unknown) => ({ err }),
          );
          const early = await Promise.race([attempt, this.deps.delay(ACCEPT_AFTER_MS).then(() => null)]);
          // Refused: it failed, or ended at once with no file. Nothing was recorded; try again straight away,
          // without a message or a segment (only giving up after all the tries is reported).
          const refused = early !== null && ("err" in early || !early.r?.uri);
          if (refused) {
            if (this.stopRequested || retries >= MAX_START_RETRIES) throw "err" in early ? early.err : new Error(CANT_CONTINUE_TEXT);
            retries++;
            await this.deps.delay(RETRY_SPACING_MS);
            continue;
          }
          this.deps.onSwitching?.(false);
          this.deps.onRunStart?.(startedAt);
          this.deps.onFlipGap?.(Math.max(0, startedAt - this.lastResolvedAt), { retries });
          const done = early ?? (await attempt);
          if ("err" in done) throw done.err;
          result = done.r;
          break;
        }
      } else {
        this.deps.onRunStart?.(startedAt);
        result = await this.deps.record(maxSec);
      }
    } catch (e) {
      this.recording = false;
      this.token++;
      if (!this.stopRequested && !this.flipRequested) {
        this.deps.onError(e instanceof Error ? e.message : "Recording failed.");
        this.stopRequested = true;
      }
      return;
    }
    this.recording = false;
    this.token++;
    this.lastResolvedAt = this.deps.now();
    const ranMs = Math.max(0, this.deps.now() - startedAt);
    if (result?.uri && ranMs < MIN_SEGMENT_MS) {
      // Too short to be footage (a start that was cut off at once): dropped here, so it never reaches the merge.
      this.deps.discardFile?.(result.uri);
    } else if (result?.uri) {
      this.deps.onSegment({
        id: this.deps.newId(),
        uri: result.uri,
        type: "video",
        // Every segment of a take (flips included) shares the take's id: one bar stretch, one "Delete last".
        runId: this.takeId,
        measuredMs: ranMs,
      });
    } else {
      this.deps.onError(NOT_SAVED_TEXT);
      this.stopRequested = true;
      this.flipRequested = false;
    }
  }
}
