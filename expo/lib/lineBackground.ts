/**
 * TikTok-style text backgrounds: each line gets its own rounded background exactly as wide as that line (plus
 * padding), the lines are stacked touching, centred, and the whole shape is one outline with smooth joins.
 * It is never wider than the widest line plus padding (a wrapped Text view is as wide as its container, which
 * is what made backgrounds look like full-width banners).
 *
 * Pure: no React, no native modules.
 */

/** Padding and corner proportions of text boxes (overlays and captions), in ems of the font size. */
export const BG_PAD_X_EM = 0.6;
export const BG_PAD_Y_EM = 0.35;
export const BG_RADIUS_EM = 0.3;

export type LineBox = {
  /** Width of the line's text in px. */
  width: number;
};

export type BackgroundGeometry = {
  /** Width and height of the whole background (the widest line + padding; lines x line height + padding). */
  width: number;
  height: number;
  /** One rect per line (x from the left edge of the whole shape), padding included. */
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  /** SVG path of the joined outline ("lines" mode), or of the single box ("box" mode). */
  path: string;
};

const f = (n: number) => Math.round(n * 100) / 100;

/**
 * Two neighbouring lines whose widths differ by less than two corner radii cannot show a full concave fillet and a full
 * convex corner side by side: the step would be a tiny notch that reads as a "T" or a staircase. They are joined at
 * the wider width instead, so the shape stays smooth (TikTok style). Lines that differ by more keep their own width and
 * meet through an inward-curving (concave) corner. Widths only ever grow, so the text always fits.
 */
export function snapNeighbours(widths: number[], radius: number): number[] {
  const w = [...widths];
  for (let pass = 0; pass < w.length; pass++) {
    let changed = false;
    for (let i = 0; i < w.length - 1; i++) {
      const d = Math.abs(w[i]! - w[i + 1]!);
      if (d > 0.5 && d < 2 * radius) {
        const m = Math.max(w[i]!, w[i + 1]!);
        w[i] = m;
        w[i + 1] = m;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return w;
}

/**
 * @param lines    the width of each line's text (px), top to bottom
 * @param lineHeight height of one line (px)
 * @param padX/padY  padding around the text (px): left and right of every line; above the first and below the last line
 * @param radius   corner radius (px)
 * @param mode     "lines": per-line shapes joined smoothly. "box": one rounded box as wide as the widest line.
 */
export function backgroundGeometry(
  lines: LineBox[],
  lineHeight: number,
  padX: number,
  padY: number,
  radius: number,
  mode: "lines" | "box" = "lines",
): BackgroundGeometry {
  const n = Math.max(1, lines.length);
  let widths = (lines.length ? lines : [{ width: 0 }]).map((l) => Math.max(0, l.width) + 2 * padX);
  if (mode === "lines" && n > 1) widths = snapNeighbours(widths, radius);
  const widest = Math.max(...widths);
  const height = n * lineHeight + 2 * padY;
  const cx = widest / 2;

  if (mode === "box" || n === 1) {
    const w = mode === "box" ? widest : widths[0]!;
    const x0 = cx - w / 2;
    const r = Math.min(radius, w / 2, height / 2);
    return {
      width: widest,
      height,
      rects: [{ x: x0, y: 0, w, h: height }],
      path: roundedRectPath(x0, 0, w, height, r),
    };
  }

  // Boundaries between lines: line i spans y[i]..y[i+1]. The first starts at 0 and includes the top padding,
  // the last ends at the bottom and includes the bottom padding.
  const ys: number[] = [0];
  for (let i = 1; i < n; i++) ys.push(padY + i * lineHeight);
  ys.push(height);
  const rects = widths.map((w, i) => ({ x: cx - w / 2, y: ys[i]!, w, h: ys[i + 1]! - ys[i]! }));

  // The outline: down the right side from the top centre, then back up the left side (the mirror image).
  type Seg = { kind: "L" | "A"; x: number; y: number; r?: number; sweep?: number };
  const right: Seg[] = [];
  const half = widths.map((w) => w / 2);
  const r0 = Math.min(radius, half[0]!, rects[0]!.h);
  right.push({ kind: "L", x: cx + half[0]! - r0, y: 0 });
  right.push({ kind: "A", x: cx + half[0]!, y: r0, r: r0, sweep: 1 });
  for (let i = 0; i < n - 1; i++) {
    const yb = ys[i + 1]!;
    const d = half[i + 1]! - half[i]!;
    if (Math.abs(d) < 0.5) {
      right.push({ kind: "L", x: cx + half[i + 1]!, y: yb });
      continue;
    }
    const rc = Math.min(radius, Math.abs(d) / 2, rects[i]!.h / 2, rects[i + 1]!.h / 2);
    if (d < 0) {
      // The next line is narrower: turn in (convex), cross, turn down (concave).
      right.push({ kind: "L", x: cx + half[i]!, y: yb - rc });
      right.push({ kind: "A", x: cx + half[i]! - rc, y: yb, r: rc, sweep: 1 });
      right.push({ kind: "L", x: cx + half[i + 1]! + rc, y: yb });
      right.push({ kind: "A", x: cx + half[i + 1]!, y: yb + rc, r: rc, sweep: 0 });
    } else {
      // The next line is wider: turn out (concave), cross, turn down (convex).
      right.push({ kind: "L", x: cx + half[i]!, y: yb - rc });
      right.push({ kind: "A", x: cx + half[i]! + rc, y: yb, r: rc, sweep: 0 });
      right.push({ kind: "L", x: cx + half[i + 1]! - rc, y: yb });
      right.push({ kind: "A", x: cx + half[i + 1]!, y: yb + rc, r: rc, sweep: 1 });
    }
  }
  const rn = Math.min(radius, half[n - 1]!, rects[n - 1]!.h);
  right.push({ kind: "L", x: cx + half[n - 1]!, y: height - rn });
  right.push({ kind: "A", x: cx + half[n - 1]! - rn, y: height, r: rn, sweep: 1 });
  right.push({ kind: "L", x: cx, y: height });

  // Points of the right side, in order, so the left side can be walked backwards and mirrored.
  const pts = [{ x: cx, y: 0 }, ...right.map((s) => ({ x: s.x, y: s.y }))];
  let d = `M${f(cx)} 0`;
  for (const s of right) d += s.kind === "L" ? ` L${f(s.x)} ${f(s.y)}` : ` A${f(s.r!)} ${f(s.r!)} 0 0 ${s.sweep} ${f(s.x)} ${f(s.y)}`;
  for (let i = right.length - 1; i >= 0; i--) {
    const s = right[i]!;
    const to = pts[i]!;
    const mx = 2 * cx - to.x;
    // Walking a mirrored segment backwards keeps its sweep flag.
    d += s.kind === "L" ? ` L${f(mx)} ${f(to.y)}` : ` A${f(s.r!)} ${f(s.r!)} 0 0 ${s.sweep} ${f(mx)} ${f(to.y)}`;
  }
  return { width: widest, height, rects, path: `${d} Z` };
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${f(x + r)} ${f(y)} L${f(x + w - r)} ${f(y)} A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)} ` +
    `L${f(x + w)} ${f(y + h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)} ` +
    `L${f(x + r)} ${f(y + h)} A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)} ` +
    `L${f(x)} ${f(y + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)} Z`
  );
}

/** Every x and y a path visits (for tests: the outline must stay inside the shape). */
export function pathPoints(path: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const m of path.matchAll(/([MLA])([^MLAZ]*)/g)) {
    const nums = m[2]!.trim().split(/[\s,]+/).map(Number);
    if (m[1] === "A") out.push({ x: nums[5]!, y: nums[6]! });
    else out.push({ x: nums[0]!, y: nums[1]! });
  }
  return out;
}
