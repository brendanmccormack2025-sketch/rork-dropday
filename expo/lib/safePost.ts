/**
 * Posting must never crash the app. Two small wrappers (pure, so they can be tested):
 *
 *  - safePost: runs the whole post flow (render, copy, upload, database insert) and turns ANY failure, a throw
 *    or a rejected promise, into a result. The caller keeps the editor and every edit, shows "Couldn't post.
 *    Try again." with a Retry button, and logs the error.
 *  - renderWithCaptionFallback: renders with the captions; if that fails (a throw counts), asks "Post without
 *    captions?" and, only if the creator confirms, renders once more without them.
 *
 * Erasable TypeScript only so the Node tests can run it.
 */

export type SafePostResult = { ok: true } | { ok: false; error: unknown; message: string };

export async function safePost(run: () => Promise<void>, onFailure?: (error: unknown) => void): Promise<SafePostResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
    try {
      onFailure?.(error);
    } catch {
      // Reporting must never be the thing that throws.
    }
    return { ok: false, error, message };
  }
}

export const POST_FAILED_TEXT = "Couldn't post. Try again.";

export type RenderStepResult<T> = { ok: true; value: T; note: string } | { ok: false; reason: string; note: string };

export type CaptionFallbackResult<T> =
  | { status: "rendered"; value: T | null; withCaptions: boolean; note: string }
  | { status: "cancelled" };

/**
 * `renderWith(true)` renders with the captions burned in, `renderWith(false)` without. It may throw.
 * With no captions it is a single plain render whose failure is not an error (the post goes out the old way).
 */
export async function renderWithCaptionFallback<T>(args: {
  hasCaptions: boolean;
  renderWith: (withCaptions: boolean) => Promise<RenderStepResult<T>>;
  /** "Post without captions?" */
  confirmWithoutCaptions: () => Promise<boolean>;
  onError?: (error: unknown) => void;
}): Promise<CaptionFallbackResult<T>> {
  const attempt = async (withCaptions: boolean): Promise<RenderStepResult<T>> => {
    try {
      return await args.renderWith(withCaptions);
    } catch (error) {
      try {
        args.onError?.(error);
      } catch {
        // ignore
      }
      return { ok: false, reason: `render error ${(error as { code?: string })?.code ?? "unknown"}`, note: "Not rendered: render error" };
    }
  };
  const first = await attempt(args.hasCaptions);
  if (first.ok) return { status: "rendered", value: first.value, withCaptions: args.hasCaptions, note: first.note };
  if (!args.hasCaptions) return { status: "rendered", value: null, withCaptions: false, note: first.note };
  // The render WITH captions failed: only a confirmed retry without them.
  if (!(await args.confirmWithoutCaptions())) return { status: "cancelled" };
  const second = await attempt(false);
  return { status: "rendered", value: second.ok ? second.value : null, withCaptions: false, note: second.note };
}
