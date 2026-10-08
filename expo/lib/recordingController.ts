/**
 * The camera's recording state machine: idle -> recording -> stopping -> idle.
 *
 * One tap starts ONE segment (one recordAsync call). Nothing restarts by itself: when a segment ends, the state
 * is idle again. The only automatic start is after a flip made WHILE recording: the segment is ended, the camera
 * is switched, and a new segment starts once the new camera is ready (see flip()). Taps while stopping (or
 * switching) are ignored, so a double tap can never start twice or stop twice.
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
  /** Resolves when the camera after a switch is ready to record. */
  afterFlipSettled(): Promise<void>;
  /** The segments recorded so far (the 60 s cap is worked out from them). */
  getSegments(): CameraSegment[];
  onSegment(segment: CameraSegment & { uri: string; type: "video" }): void;
  onState(state: RecState): void;
  onError(message: string | null): void;
  /** True while a flip is switching cameras (for the blur over the preview). */
  onSwitching?(switching: boolean): void;
  onRunStart?(startedAt: number): void;
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

export class RecordingController {
  state: RecState = "idle";
  private deps: RecordingDeps;
  private stopRequested = false;
  private flipRequested = false;
  private recording = false;
  private running: Promise<void> = Promise.resolve();
  /** Identifies the native recording in progress, so an old cap timer never stops a newer segment. */
  private token = 0;

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
   * Flip the camera. Idle: just switch. Recording: end this segment, switch, wait until the new camera is ready,
   * then start a new segment. While stopping/switching: ignored.
   */
  flip(): boolean {
    if (this.state === "stopping") return false;
    if (this.state === "idle") {
      this.deps.switchFacing();
      return true;
    }
    this.flipRequested = true;
    this.set("stopping");
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
    try {
      for (;;) {
        await this.recordOne();
        if (!this.flipRequested) break;
        // A flip while recording: the segment has ended; switch cameras and start again when the new one is ready.
        this.flipRequested = false;
        this.set("stopping");
        this.deps.onSwitching?.(true);
        this.deps.switchFacing();
        await this.deps.afterFlipSettled();
        this.deps.onSwitching?.(false);
        if (this.stopRequested || !canRecordMore(this.deps.getSegments())) break;
        this.set("recording");
      }
    } catch (e) {
      this.deps.onError(e instanceof Error ? e.message : "Recording failed.");
    } finally {
      this.recording = false;
      this.deps.onSwitching?.(false);
      this.set("idle");
    }
  }

  private async recordOne(): Promise<void> {
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
    const startedAt = this.deps.now();
    this.deps.onRunStart?.(startedAt);
    this.recording = true;
    const mine = ++this.token;
    // Safety net: the recorder is given the remaining time, but if it does not stop by itself, stop it.
    void this.deps.delay(remainingMs(segments) + 400).then(() => {
      if (this.recording && this.token === mine) this.deps.stopNative();
    });
    let result: { uri?: string } | null | undefined;
    try {
      result = await this.deps.record(maxSec);
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
    if (result?.uri) {
      this.deps.onSegment({
        id: this.deps.newId(),
        uri: result.uri,
        type: "video",
        runId: this.deps.newId(),
        measuredMs: Math.max(0, this.deps.now() - startedAt),
      });
    } else {
      this.deps.onError(NOT_SAVED_TEXT);
      this.stopRequested = true;
      this.flipRequested = false;
    }
  }
}
