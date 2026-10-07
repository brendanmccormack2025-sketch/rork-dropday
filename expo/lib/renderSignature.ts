/**
 * What a background render is for, and when it is still good.
 *
 *  - PREVIEW render: the cuts only. The editor draws the captions itself over it (live captions are instant:
 *    an edit, move or style never re-renders the preview), so the captions are not part of its signature.
 *  - FINAL render: the cuts with the captions burned in; it is what Post uses. Its signature includes the
 *    captions, so any edit (a cut OR a caption) makes it stale.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */
import type { EditOverlay } from "./editModel.ts";

type ClipKey = { uri: string; trimStartMs?: number; trimEndMs?: number; durationMs?: number };

export function captionsKeyOf(captions: EditOverlay[] | undefined): string {
  return JSON.stringify(captions ?? []);
}

export function rawKeyOf(clips: ClipKey[]): string {
  return JSON.stringify(
    clips.map((c) => [c.uri, c.trimStartMs ?? 0, c.trimEndMs && c.trimEndMs > 0 ? c.trimEndMs : (c.durationMs ?? 0)]),
  );
}

/** The signature of a render of these clips (and, for the final render, these captions) at this size. */
export function renderSignature(args: {
  clips: ClipKey[];
  captions?: EditOverlay[];
  /** The final render burns the captions in; the preview does not. */
  includeCaptions: boolean;
  size: { width: number; height: number };
}): string {
  const captions = args.includeCaptions ? args.captions : undefined;
  return `${rawKeyOf(args.clips)}~${captionsKeyOf(captions)}|${args.size.width}x${args.size.height}`;
}

/** Which render Post uses: with captions the final one (captions burned in), otherwise the preview's. */
export function postRenderSource(captionCount: number): "final" | "preview" {
  return captionCount > 0 ? "final" : "preview";
}

/** A finished render is fresh when it was made for exactly the current signature. */
export function isFresh(state: { kind: string; signature?: string }, current: string | null): boolean {
  return state.kind === "ready" && current !== null && state.signature === current;
}

/** What Post does about the render: use a fresh finished one, wait for the running one, or render now ("Finishing video…"). */
export function planPostRender(args: {
  state: { kind: string; signature?: string };
  current: string | null;
}): "use-ready" | "wait-for-running" | "render-now" {
  if (isFresh(args.state, args.current)) return "use-ready";
  if (args.state.kind === "rendering" && args.current !== null && args.state.signature === args.current) return "wait-for-running";
  return "render-now";
}
