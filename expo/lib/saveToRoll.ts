/**
 * Save the edited video to the camera roll. The flow, with its effects passed in so it can be tested:
 * it never throws and never touches the post; every problem is a result.
 *
 * Pure: no React, no native modules.
 */
export type SaveToRollResult =
  | { status: "off" }
  | { status: "saved" }
  | { status: "failed"; reason: string; /** The real error text (shown to the owner account only). */ detail?: string };

type Stage = "render" | "permission" | "save";

export type SaveToRollDeps = {
  /** The "Save to camera roll" switch. */
  enabled: boolean;
  /**
   * The video that was posted (cuts and captions burned in), a staged copy. The saved video is exactly this file.
   * Text-button overlays are never part of it: creators add their own text in TikTok / Instagram.
   */
  postedUri?: string | null;
  /** Render cuts and captions when there is no posted file to save (the post went out as source clips). */
  render: () => Promise<{ uri: string }>;
  /** Add-only photo permission; true when granted. */
  ensurePermission: () => Promise<boolean>;
  save: (uri: string) => Promise<void>;
  /** Delete a temporary file. */
  cleanup: (uri: string) => Promise<void>;
  onError?: (error: unknown, stage: Stage) => void;
};

function report(deps: SaveToRollDeps, error: unknown, stage: Stage): void {
  try {
    deps.onError?.(error, stage);
  } catch {
    // Reporting must never be the thing that throws.
  }
}

const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e ?? "unknown error").slice(0, 300);

export async function saveToCameraRoll(deps: SaveToRollDeps): Promise<SaveToRollResult> {
  if (!deps.enabled) return { status: "off" };
  const temps: string[] = [];
  try {
    try {
      const granted = await deps.ensurePermission();
      if (!granted) {
        const err = new Error("photo permission was not granted");
        report(deps, err, "permission");
        return { status: "failed", reason: "permission", detail: messageOf(err) };
      }
    } catch (e) {
      report(deps, e, "permission");
      return { status: "failed", reason: "permission", detail: `permission: ${messageOf(e)}` };
    }

    let file: string;
    if (deps.postedUri) {
      file = deps.postedUri;
    } else {
      try {
        file = (await deps.render()).uri;
        temps.push(file);
      } catch (e) {
        report(deps, e, "render");
        return { status: "failed", reason: "render", detail: `render: ${messageOf(e)}` };
      }
    }

    try {
      await deps.save(file);
    } catch (e) {
      report(deps, e, "save");
      return { status: "failed", reason: "save", detail: `save: ${messageOf(e)}` };
    }
    // Saved: the staged copy of the posted file is no longer needed (until then it stays, so Retry can use it).
    if (deps.postedUri) temps.push(deps.postedUri);
    return { status: "saved" };
  } finally {
    for (const t of temps) {
      try {
        await deps.cleanup(t);
      } catch {
        // A leftover temp file is not an error.
      }
    }
  }
}

// ── What the screen shows ──

export type SaveToRollState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; retry: () => void; detail?: string };

export const SAVE_FAILED_TEXT = "Couldn't save to camera roll";
export const SAVE_SAVING_TEXT = "Saving to camera roll…";
export const SAVE_SAVED_TEXT = "Saved to camera roll";

/** A tiny observable (one state, many listeners) for the little message at the top of the screen. */
export function createSaveStatus() {
  let state: SaveToRollState = { kind: "idle" };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: SaveToRollState) {
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/** Run a save, reflecting it in the status; a failure offers Retry (which runs the same save again). */
export async function runSaveWithStatus(
  status: ReturnType<typeof createSaveStatus>,
  run: () => Promise<SaveToRollResult>,
  /** Show the real error reason in the failure message (the owner account only). */
  showDetail = false,
): Promise<SaveToRollResult> {
  status.set({ kind: "saving" });
  let result: SaveToRollResult;
  try {
    result = await run();
  } catch {
    result = { status: "failed", reason: "unexpected" };
  }
  if (result.status === "failed") {
    status.set({ kind: "failed", retry: () => void runSaveWithStatus(status, run, showDetail), ...(showDetail && result.detail ? { detail: result.detail } : {}) });
  } else if (result.status === "saved") {
    status.set({ kind: "saved" });
  } else {
    status.set({ kind: "idle" });
  }
  return result;
}
