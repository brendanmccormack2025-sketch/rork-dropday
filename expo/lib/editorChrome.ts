/**
 * What the full-screen editor shows, and where: only the controls for the current task are visible, and nothing
 * overlaps. One place for the visibility rules and the layout numbers (edit.tsx uses both), so a test can check every
 * state on every phone size, down to the 375 pt iPhone.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type EditorStep = "cuts" | "edit" | "post";

export type ChromeState = {
  step: EditorStep;
  /** The text overlay editor is open (typing). */
  textEditing: boolean;
  /** Any sheet / panel is open: Captions, Caption style, Cuts, a marker sheet. */
  panelOpen: boolean;
  keyboardUp: boolean;
  /** A text overlay or the caption is selected (its bar is showing). */
  hasSelection: boolean;
  isPlaying: boolean;
  /** Waiting for the preview to render before playing. */
  pendingPlay: boolean;
  /** "Preview ready" is inside its 1.5 s window. */
  readyLabelActive: boolean;
};

export type ChromeVisibility = {
  topBar: boolean;
  toolColumn: boolean;
  /** Next (the editor's primary button). */
  next: boolean;
  selectionBar: boolean;
  playButton: boolean;
  readyLabel: boolean;
};

export function chromeVisibility(s: ChromeState): ChromeVisibility {
  // Typing, an open panel or the keyboard: the editor is about that one thing, so every other control steps aside.
  const focused = s.textEditing || s.panelOpen || s.keyboardUp;
  const free = !focused && !s.hasSelection;
  const playable = !s.isPlaying && !s.pendingPlay;
  if (s.step !== "edit") {
    return { topBar: false, toolColumn: false, next: false, selectionBar: false, playButton: !focused && playable, readyLabel: !focused && s.readyLabelActive };
  }
  return {
    topBar: !focused,
    toolColumn: free,
    next: free,
    selectionBar: !focused && s.hasSelection,
    playButton: free && playable,
    readyLabel: free && s.readyLabelActive,
  };
}

// ── "Preview ready": shown for about 1.5 s, then fades out ──
export const READY_LABEL_SHOW_MS = 1500;
export const READY_LABEL_FADE_MS = 300;

// ── Layout numbers of the full-screen editor (pt) ──
export const E_TOP_BAR = { top: 6, side: 12, button: 40 };
export const E_TOOLS = { top: 74, right: 10, width: 56, toolHeight: 44, gap: 14 };
export const E_BAR = { height: 44, side: 16, topOffset: 64, bottomOffset: 14 };
export const E_NEXT = { height: 48, width: 112, right: 16, bottomOffset: 16 };
export const E_READY = { topOffset: 62, left: 16, height: 22, width: 150 };
export const E_PLAY = { size: 64 };
/** The tools of the column (Text, Captions, Cuts: Style lives in the Captions panel and the caption's own bar). */
export const E_TOOL_COUNT_MAX = 3;

export type Rect = { name: string; x: number; y: number; w: number; h: number };

/** The rectangles of every control that is visible in this state, for overlap checks. */
export function editorRects(
  screen: { w: number; h: number; insetTop: number; insetBottom: number },
  vis: ChromeVisibility,
  opts: { toolCount?: number; barOnTop?: boolean } = {},
): Rect[] {
  const out: Rect[] = [];
  const { w, h, insetTop, insetBottom } = screen;
  if (vis.topBar) {
    out.push({ name: "back", x: E_TOP_BAR.side, y: insetTop + E_TOP_BAR.top, w: E_TOP_BAR.button, h: E_TOP_BAR.button });
    out.push({ name: "undo", x: w - E_TOP_BAR.side - 2 * E_TOP_BAR.button - 8, y: insetTop + E_TOP_BAR.top, w: E_TOP_BAR.button, h: E_TOP_BAR.button });
    out.push({ name: "redo", x: w - E_TOP_BAR.side - E_TOP_BAR.button, y: insetTop + E_TOP_BAR.top, w: E_TOP_BAR.button, h: E_TOP_BAR.button });
  }
  if (vis.toolColumn) {
    const n = opts.toolCount ?? E_TOOL_COUNT_MAX;
    const colH = n * E_TOOLS.toolHeight + (n - 1) * E_TOOLS.gap;
    out.push({ name: "tools", x: w - E_TOOLS.right - E_TOOLS.width, y: insetTop + E_TOOLS.top, w: E_TOOLS.width, h: colH });
  }
  if (vis.selectionBar) {
    const y = opts.barOnTop ? insetTop + E_BAR.topOffset : h - insetBottom - E_BAR.bottomOffset - E_BAR.height;
    out.push({ name: "selectionBar", x: E_BAR.side, y, w: w - 2 * E_BAR.side, h: E_BAR.height });
  }
  if (vis.next) {
    out.push({ name: "next", x: w - E_NEXT.right - E_NEXT.width, y: h - insetBottom - E_NEXT.bottomOffset - E_NEXT.height, w: E_NEXT.width, h: E_NEXT.height });
  }
  if (vis.readyLabel) {
    out.push({ name: "ready", x: E_READY.left, y: insetTop + E_READY.topOffset, w: E_READY.width, h: E_READY.height });
  }
  if (vis.playButton) {
    out.push({ name: "play", x: (w - E_PLAY.size) / 2, y: (h - E_PLAY.size) / 2, w: E_PLAY.size, h: E_PLAY.size });
  }
  return out;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Pairs of overlapping controls (empty = nothing overlaps). */
export function overlappingPairs(rects: Rect[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i]!, rects[j]!)) out.push([rects[i]!.name, rects[j]!.name]);
  return out;
}

/**
 * How far (px) to slide the preview up so the caption stays visible above a panel / the keyboard.
 * `visibleBottom` is the y of the top of whatever covers the bottom of the screen.
 */
export function captionLift(args: { frameTop: number; frameHeight: number; captionYFrac: number; captionHalfHeight: number; visibleBottom: number; margin?: number }): number {
  const bottom = args.frameTop + args.frameHeight * args.captionYFrac + args.captionHalfHeight + (args.margin ?? 12);
  return Math.max(0, Math.round(bottom - args.visibleBottom));
}

/** The Captions panel is a half-height bottom sheet at most; while a line is edited it is a compact bar above the keyboard. */
export const CAPTIONS_SHEET_MAX_FRACTION = 0.45;
export const CAPTIONS_EDIT_BAR_HEIGHT = 72;
