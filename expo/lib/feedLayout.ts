/**
 * Feed geometry shared by the feed player, the editor preview and the full-screen
 * Preview, so what the editor shows is what the feed shows.
 *
 * Pure data and functions: no React, no native modules.
 */

export const TAB_BAR_HEIGHT = 88;
/** Assumed aspect ratio (w/h) of posted video. */
export const VIDEO_ASPECT = 9 / 16;

export type CoverCrop = { visibleW: number; visibleH: number; cropLeft: number; cropTop: number };

/**
 * The visible fraction of a video after "cover" resizing fills a container of a
 * different aspect (centered crop). This is the feed player's math.
 */
export function computeCoverCrop(containerW: number, containerH: number, videoAspect: number): CoverCrop {
  if (containerW <= 0 || containerH <= 0) {
    return { visibleW: 1, visibleH: 1, cropLeft: 0, cropTop: 0 };
  }
  const containerAspect = containerW / containerH;
  if (videoAspect < containerAspect) {
    const scaledVideoH = containerW / videoAspect;
    const visibleH = containerH / scaledVideoH;
    return { visibleW: 1, visibleH, cropLeft: 0, cropTop: (1 - visibleH) / 2 };
  }
  const scaledVideoW = containerH * videoAspect;
  const visibleW = containerW / scaledVideoW;
  return { visibleW, visibleH: 1, cropLeft: (1 - visibleW) / 2, cropTop: 0 };
}

/** The feed item's aspect (w/h): the full-screen list item the video fills. */
export function feedAspect(screenW: number, screenH: number): number {
  return screenW > 0 && screenH > 0 ? screenW / screenH : VIDEO_ASPECT;
}

/** The largest feed-shaped frame that fits an area. */
export function fitFrame(areaW: number, areaH: number, aspect: number): { w: number; h: number } {
  if (areaW <= 0 || areaH <= 0 || aspect <= 0) return { w: Math.max(0, areaW), h: Math.max(0, areaH) };
  if (areaW / areaH > aspect) return { w: areaH * aspect, h: areaH };
  return { w: areaW, h: areaW / aspect };
}

/** Width of the whole (uncropped) video as it is displayed in a cover frame. */
export function videoDisplayWidth(frameW: number, crop: CoverCrop): number {
  return crop.visibleW > 0 ? frameW / crop.visibleW : frameW;
}

/** Full-video fraction (0..1) -> frame pixels, through the cover crop. */
export function fracToFrame(x: number, y: number, frameW: number, frameH: number, crop: CoverCrop) {
  return { x: ((x - crop.cropLeft) / crop.visibleW) * frameW, y: ((y - crop.cropTop) / crop.visibleH) * frameH };
}

/** Frame pixels -> full-video fraction (0..1). Inverse of fracToFrame. */
export function frameToFrac(px: number, py: number, frameW: number, frameH: number, crop: CoverCrop) {
  return { x: crop.cropLeft + (px / frameW) * crop.visibleW, y: crop.cropTop + (py / frameH) * crop.visibleH };
}

// ── Feed chrome (mirrors FeedItem / the feed header) ─────────────────────────

export const FEED_CHROME = {
  headerPadX: 18,
  headerPadTop: 4,
  logoW: 72,
  logoH: 22,
  bellSize: 36,
  railRight: 12,
  railBottomOffset: 22,
  railGap: 20,
  railAvatar: 40,
  railIcon: 36,
  /** Heights of the rail's items, top to bottom: avatar, like, react, share, more, views. */
  railItemHeights: [40, 55, 55, 36, 36, 40],
  bottomLeft: 18,
  bottomRight: 84,
  bottomOffset: 24,
  bottomHeight: 96,
} as const;

export type Rect = { x: number; y: number; w: number; h: number };
export type SafeZones = { logo: Rect; bell: Rect; rail: Rect; bottom: Rect };

/**
 * Where the feed draws its UI over a frame of width W and height H. The frame is
 * the full-screen item scaled to fit the editor, so chrome sizes scale with `s`
 * (frame width / screen width) and the zones land where the real UI does.
 */
export function safeZones(frameW: number, frameH: number, screenW: number, topInset = 0, bottomInset = TAB_BAR_HEIGHT): SafeZones {
  const s = screenW > 0 ? frameW / screenW : 1;
  const c = FEED_CHROME;
  const top = (topInset + c.headerPadTop) * s;
  const railH = (c.railItemHeights.reduce((a, b) => a + b, 0) + (c.railItemHeights.length - 1) * c.railGap) * s;
  const railW = c.railIcon * s;
  const railBottom = (bottomInset + c.railBottomOffset) * s;
  return {
    logo: { x: c.headerPadX * s, y: top, w: c.logoW * s, h: c.logoH * s },
    bell: { x: frameW - (c.headerPadX + c.bellSize) * s, y: top, w: c.bellSize * s, h: c.bellSize * s },
    rail: { x: frameW - (c.railRight * s + railW), y: frameH - railBottom - railH, w: railW, h: railH },
    bottom: {
      x: c.bottomLeft * s,
      y: frameH - (bottomInset + c.bottomOffset) * s - c.bottomHeight * s,
      w: frameW - (c.bottomLeft + c.bottomRight) * s,
      h: c.bottomHeight * s,
    },
  };
}

// ── Text overlay layout (editor preview == feed) ─────────────────────────────

/** A text overlay's fontSize is in points of a frame this wide, and scales with the video width. */
export const TEXT_REF_WIDTH = 250;
/** Widest a text box may get, as a fraction of the video width (the native renderer's default). */
export const TEXT_MAX_WIDTH = 0.86;
/** Space between the text and the edge of its box. One value on all sides: the renderer's backgroundPadding is uniform. */
export const TEXT_PAD_EM = 0.3;
export const TEXT_RADIUS_EM = 0.25;
export const TEXT_LINE_HEIGHT_EM = 1.18;

export type TextLayout = {
  fontSize: number;
  lineHeight: number;
  padX: number;
  padY: number;
  cornerRadius: number;
  /** Max width of the whole box (text + padding) in pixels. */
  maxWidth: number;
};

/** Sizes in pixels for a text overlay on a video displayed `videoW` pixels wide. */
export function textLayout(overlayFontSize: number | undefined, videoW: number): TextLayout {
  const fontSize = (overlayFontSize ?? 26) * (videoW / TEXT_REF_WIDTH);
  return {
    fontSize,
    lineHeight: fontSize * TEXT_LINE_HEIGHT_EM,
    padX: fontSize * TEXT_PAD_EM,
    padY: fontSize * TEXT_PAD_EM,
    cornerRadius: fontSize * TEXT_RADIUS_EM,
    maxWidth: videoW * TEXT_MAX_WIDTH,
  };
}

/**
 * A text overlay as the renderer's style numbers (for a 1080-wide frame). The preview and the
 * feed size everything from textLayout; this is the same layout in the renderer's units.
 */
export function textOverlayRenderSpec(overlayFontSize: number | undefined) {
  const l = textLayout(overlayFontSize, 1080);
  return {
    fontSize: l.fontSize,
    backgroundPadding: l.padX,
    cornerRadius: l.cornerRadius,
    maxWidth: TEXT_MAX_WIDTH,
  };
}

/**
 * Word-wrap `text` into lines of at most `maxTextWidth`, where every character is `charEm` ems
 * wide and an emoji or other wide character is `wideEm`. A rough model, used to compare layouts.
 */
export function wrapLines(text: string, fontSize: number, maxTextWidth: number, charEm = 0.55, wideEm = 1.1): string[] {
  const width = (w: string) => [...w].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2000 ? wideEm : charEm) * fontSize, 0);
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next) > maxTextWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}
