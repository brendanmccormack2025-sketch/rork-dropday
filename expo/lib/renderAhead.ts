/**
 * Render-ahead: while the user edits, render the timeline in the background with
 * the native VideoRender module (the same instructions and options as
 * render-at-post, see lib/renderAtPost.ts), so the editor can play ONE finished
 * file and Post can reuse it.
 *
 * Never blocks the UI. Every failure is silent (logged, reason kept); after 2
 * failures in one editor session it stops trying. Native rendering is one at a
 * time, so a change mid-render cancels it and waits for it to finish before the
 * next render starts.
 */
import { AppState, type AppStateStatus } from "react-native";

import { deleteAsync } from "@/lib/fileSystemCompat";
import {
  buildRenderEdit,
  checkRenderResult,
  computeRenderSize,
  renderRequest,
  renderSkipReason,
  renderTimeoutMs,
} from "@/lib/renderAtPost";
import { recordRenderStats } from "@/lib/renderReport";
import type { EditOverlay } from "@/lib/editModel";
import { captionsKeyOf, rawKeyOf, renderSignature } from "@/lib/renderSignature";
import type { DraftClip } from "@/providers/PostsProvider";

/** The timeline must be unchanged this long before a background render starts. */
export const RENDER_AHEAD_IDLE_MS = 1200;
/** Same for a change that only touches the captions. */
export const RENDER_AHEAD_CAPTION_IDLE_MS = 800;
/**
 * The FINAL render (cuts plus captions burned in) starts after this long with no edit; any edit cancels it.
 * The preview render never has captions (the editor draws them itself), so a caption edit never re-renders it.
 */
export const RENDER_FINAL_IDLE_MS = 2000;

export type RenderAheadOptions = {
  /** Burn the caption overlays in (the final render). false: cuts only (the preview render). */
  includeCaptions?: boolean;
  /** Only render when there are caption overlays to burn in. */
  requireCaptions?: boolean;
  /** Idle time before a render starts (ms). */
  idleMs?: number;
};

/**
 * Native rendering is one at a time, and the preview and the final render share it: whoever asks second waits
 * for the first to finish (or be cancelled).
 */
let nativeChain: Promise<void> = Promise.resolve();
export function acquireNative(): Promise<() => void> {
  let release: () => void = () => {};
  const prev = nativeChain;
  nativeChain = new Promise<void>((r) => {
    release = r;
  });
  return prev.then(() => release);
}
/** Longest timeline rendered ahead. */
export const RENDER_AHEAD_MAX_EDIT_MS = 180_000;
/** Failures in one editor session before it stops trying. */
export const RENDER_AHEAD_MAX_FAILURES = 2;
/** A replaced file is deleted this long after, so a player still holding it can let go. */
const STALE_DELETE_DELAY_MS = 2000;

export type AheadReady = {
  signature: string;
  uri: string;
  durationMs: number;
  sizeBytes: number;
  /** How long the render took. */
  renderMs: number;
};

export type AheadState =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "rendering"; signature: string; progress: number }
  | ({ kind: "ready" } & AheadReady)
  | { kind: "failed"; reason: string };

export type AheadOutcome =
  | { ok: true; ready: AheadReady }
  | { ok: false; reason: string };

type Args = {
  clips: DraftClip[];
  isRoot: boolean;
  userId: string | null | undefined;
  /** Caption (and other) overlays on the output timeline, burned into every render. */
  captions?: EditOverlay[];
  /** True while captions are still being transcribed: no render starts until it clears. */
  hold?: boolean;
};

export class RenderAhead {
  private state: AheadState = { kind: "idle" };
  private listeners = new Set<(s: AheadState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private appActive = AppState.currentState === "active";
  private appSub: { remove(): void } | null;
  private failures = 0;
  private disposed = false;
  private suspended = false;
  private args: Args | null = null;
  private raw: string | null = null;
  private waitingForActive = false;
  private immediateNext = false;
  private hold = false;
  private clipsKey: string | null = null;
  private sizes = new Map<string, { width: number; height: number }>();
  /** The render in flight (and the settle promise of the last one). */
  private inflight: { promise: Promise<void>; cancel: () => void; done: Promise<AheadOutcome> } | null = null;
  /** Why the last attempt did not produce a file (for the render report). */
  lastFailureReason: string | null = null;

  private readonly includeCaptions: boolean;
  private readonly requireCaptions: boolean;
  private readonly idleMs: number;

  constructor(options: RenderAheadOptions = {}) {
    this.includeCaptions = options.includeCaptions ?? true;
    this.requireCaptions = options.requireCaptions ?? false;
    this.idleMs = options.idleMs ?? RENDER_AHEAD_IDLE_MS;
    this.appSub = AppState.addEventListener("change", (next: AppStateStatus) => {
      this.appActive = next === "active";
      if (this.appActive && this.waitingForActive) {
        this.waitingForActive = false;
        this.startTimer();
      }
    });
  }

  getState(): AheadState {
    return this.state;
  }

  subscribe(listener: (s: AheadState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The signature of a timeline: its clips (uri, trimStartMs, trimEndMs) and the
   * render size. null until the size for the first clip is known.
   */
  signatureOf(clips: DraftClip[], captions?: EditOverlay[]): string | null {
    const first = clips[0];
    const size = first ? this.sizes.get(first.uri) : undefined;
    return size ? renderSignature({ clips, captions, includeCaptions: this.includeCaptions, size }) : null;
  }

  /** Call whenever the timeline (or who is editing) changes. */
  update(args: Args): void {
    if (this.disposed || this.suspended) return;
    this.args = args;
    const hold = !!args.hold;
    const released = this.hold && !hold;
    this.hold = hold;
    if (hold) this.clearTimer();
    if (this.eligible(args) !== null) {
      this.raw = null;
      this.clearTimer();
      this.invalidate();
      this.setState({ kind: "idle" });
      return;
    }
    const clipsKey = rawKeyOf(args.clips);
    const raw = `${clipsKey}~${captionsKeyOf(this.captionsOf(args))}`;
    if (raw === this.raw) {
      // Same timeline and captions: nothing to redo, except start once the hold clears.
      if (released && this.state.kind === "waiting") {
        this.immediateNext = true;
        this.startTimer();
      }
      return;
    }
    const captionsOnly = clipsKey === this.clipsKey;
    this.raw = raw;
    this.clipsKey = clipsKey;
    this.invalidate();
    this.setState({ kind: "waiting" });
    if (hold) return; // the timer starts when the hold clears
    if (released) this.immediateNext = true;
    this.startTimer(this.includeCaptions ? this.idleMs : captionsOnly ? RENDER_AHEAD_CAPTION_IDLE_MS : this.idleMs);
  }

  /** The next render starts without the idle delay (the first one after auto-edit applies). */
  startNextImmediately(): void {
    this.immediateNext = true;
  }

  /** Hand the ready file for this signature to the caller (it must delete it). */
  takeReady(signature: string): AheadReady | null {
    if (this.state.kind !== "ready" || this.state.signature !== signature) return null;
    const { kind: _kind, ...ready } = this.state;
    this.suspended = true;
    this.clearTimer();
    this.state = { kind: "idle" };
    this.notify();
    return ready;
  }

  /** True while a render for exactly this signature is running. */
  isRenderingFor(signature: string): boolean {
    return this.state.kind === "rendering" && this.state.signature === signature && !!this.inflight;
  }

  /** Wait for the running render (see isRenderingFor). Never rejects. */
  async waitFor(signature: string): Promise<AheadOutcome> {
    const inflight = this.inflight;
    if (!inflight || !this.isRenderingFor(signature)) return { ok: false, reason: "no render in progress" };
    this.suspended = true; // the caller owns the result: no restarts
    const outcome = await inflight.done;
    if (outcome.ok) {
      // Ownership passes to the caller.
      if (this.state.kind === "ready" && this.state.signature === outcome.ready.signature) {
        this.state = { kind: "idle" };
        this.notify();
      }
    }
    return outcome;
  }

  /** Start again after cancelAndSuspend / takeReady (a Post that was cancelled or failed): the editor keeps rendering. */
  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    this.raw = null;
    const args = this.args;
    if (args) this.update(args);
    else this.setState({ kind: "idle" });
  }

  /** Stop everything: cancel any render, wait for it, delete files. Used before Post renders on its own. */
  async cancelAndSuspend(): Promise<void> {
    this.suspended = true;
    this.clearTimer();
    this.invalidate();
    if (this.inflight) await this.inflight.promise.catch(() => {});
    this.setState({ kind: "idle" });
  }

  /** The editor closed: cancel, delete every file the manager still owns. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.appSub?.remove();
    this.appSub = null;
    this.invalidate(true);
    this.listeners.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The overlays this instance burns in (none for the preview render). */
  private captionsOf(args: Args): EditOverlay[] | undefined {
    return this.includeCaptions ? args.captions : undefined;
  }

  private eligible(args: Args): string | null {
    if (this.failures >= RENDER_AHEAD_MAX_FAILURES) return "too many failures";
    const overlays = this.captionsOf(args);
    if (this.requireCaptions && (overlays?.length ?? 0) === 0) return "no captions";
    const reason = renderSkipReason({ isRoot: args.isRoot, userId: args.userId, clips: args.clips, hasOverlays: (overlays?.length ?? 0) > 0 });
    if (reason) return reason;
    if (buildRenderEdit(args.clips).editMs > RENDER_AHEAD_MAX_EDIT_MS) return "too long";
    return null;
  }

  private setState(next: AheadState): void {
    this.state = next;
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((l) => l(this.state));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private startTimer(idleMs: number = this.idleMs): void {
    this.clearTimer();
    const delay = this.immediateNext ? 0 : idleMs;
    this.immediateNext = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.begin();
    }, delay);
  }

  private deleteLater(uri: string, delayMs: number): void {
    setTimeout(() => {
      deleteAsync(uri, { idempotent: true }).catch(() => {});
    }, delayMs);
  }

  /** The timeline changed (or stopped qualifying): cancel the render, drop the ready file. */
  private invalidate(deleteNow = false): void {
    if (this.inflight) this.inflight.cancel();
    if (this.state.kind === "ready") {
      if (deleteNow) deleteAsync(this.state.uri, { idempotent: true }).catch(() => {});
      else this.deleteLater(this.state.uri, STALE_DELETE_DELAY_MS);
    }
  }

  private async begin(): Promise<void> {
    if (this.disposed || this.suspended) return;
    if (!this.appActive) {
      this.waitingForActive = true; // resume when the app is active again
      return;
    }
    const args = this.args;
    const raw = this.raw;
    if (!args || !raw || this.eligible(args) !== null) return;
    // Native rendering is one at a time: let a cancelled render finish first.
    if (this.inflight) await this.inflight.promise.catch(() => {});
    if (this.disposed || this.suspended || this.raw !== raw) return;

    let size = this.sizes.get(args.clips[0]!.uri);
    if (!size) {
      size = await computeRenderSize(args.clips[0]!);
      this.sizes.set(args.clips[0]!.uri, size);
    }
    if (this.disposed || this.suspended || this.raw !== raw) return;
    const signature = `${raw}|${size.width}x${size.height}`;
    const captions = this.captionsOf(args);
    const { edit, editMs } = buildRenderEdit(args.clips);

    let cancelled = false;
    let timedOut = false;
    let cancelNative: () => void = () => {};
    let resolveDone: (o: AheadOutcome) => void = () => {};
    const done = new Promise<AheadOutcome>((r) => {
      resolveDone = r;
    });
    const promise = (async () => {
      let subscription: { remove(): void } | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const started = Date.now();
      let outcome: AheadOutcome;
      // The preview and the final render take turns (one native render at a time).
      const releaseNative = await acquireNative();
      try {
        const { addRenderProgressListener, cancelRender, renderAsync } = await import("@/modules/video-render");
        cancelNative = cancelRender;
        if (cancelled) throw Object.assign(new Error("cancelled"), { code: "ERR_RENDER_CANCELLED" });
        let lastProgress = 0;
        subscription = addRenderProgressListener((e) => {
          if (cancelled || this.disposed || e.progress - lastProgress < 0.02) return;
          lastProgress = e.progress;
          if (this.inflight && this.raw === raw) this.setState({ kind: "rendering", signature, progress: e.progress });
        });
        timeout = setTimeout(() => {
          timedOut = true;
          cancelRender();
        }, renderTimeoutMs(editMs));
        const request = renderRequest(edit, size!.width, size!.height, captions);
        const result = await renderAsync(request.json, request.options);
        const bad = checkRenderResult(result, editMs);
        if (bad) {
          deleteAsync(result.uri, { idempotent: true }).catch(() => {});
          outcome = { ok: false, reason: bad };
        } else if (cancelled || this.disposed || this.raw !== raw) {
          deleteAsync(result.uri, { idempotent: true }).catch(() => {});
          outcome = { ok: false, reason: "cancelled" };
        } else {
          recordRenderStats({
            kind: "ahead",
            renderMs: Date.now() - started,
            durationMs: result.actualDurationMs,
            sizeBytes: result.sizeBytes,
          });
          outcome = {
            ok: true,
            ready: {
              signature,
              uri: result.uri,
              durationMs: result.actualDurationMs,
              sizeBytes: result.sizeBytes,
              renderMs: Date.now() - started,
            },
          };
        }
      } catch (e) {
        const code = (e as { code?: string })?.code;
        outcome = timedOut
          ? { ok: false, reason: `timeout after ${Math.round(renderTimeoutMs(editMs) / 1000)} s` }
          : code === "ERR_RENDER_CANCELLED"
            ? { ok: false, reason: "cancelled" }
            : { ok: false, reason: `render error ${code ?? "unknown"}` };
        if (__DEV__) console.log("[renderAhead] render failed:", code, (e as Error)?.message);
      } finally {
        if (timeout) clearTimeout(timeout);
        subscription?.remove();
        releaseNative();
      }
      this.inflight = null;
      resolveDone(outcome);
      if (this.disposed) {
        if (outcome.ok) deleteAsync(outcome.ready.uri, { idempotent: true }).catch(() => {});
        return;
      }
      if (outcome.ok) {
        if (this.raw === raw && !this.suspended) {
          this.lastFailureReason = null;
          this.setState({ kind: "ready", ...outcome.ready });
        } else if (this.suspended && this.raw === raw) {
          // The caller (waitFor) owns it now: leave the file alone.
        } else {
          deleteAsync(outcome.ready.uri, { idempotent: true }).catch(() => {});
        }
      } else if (outcome.reason !== "cancelled" || timedOut) {
        // Our own cancel (a newer edit) is not a failure; leaving the app is not either.
        if (this.appActive) this.failures += 1;
        this.lastFailureReason = outcome.reason;
        if (this.raw === raw) this.setState({ kind: "failed", reason: outcome.reason });
      }
    })();

    this.inflight = {
      promise,
      done,
      cancel: () => {
        cancelled = true;
        cancelNative();
      },
    };
    this.setState({ kind: "rendering", signature, progress: 0 });
  }
}
