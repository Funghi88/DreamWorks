/**
 * Width (CSS px) of the largest 16:9 rectangle that fits inside a W×H box.
 * This is the “16” side of the 16:9 reference used for share layout (not always === W).
 */
export function largest16x9WidthInside(cssW: number, cssH: number): number {
  const W = Math.max(1, cssW);
  const H = Math.max(1, cssH);
  return Math.min(W, H * (16 / 9));
}

/**
 * Screen / whiteboard composite: target width = fillRatio × **basisW** (defaults to full frame width; fillRatio default 0.8).
 * - Export (16:9 output): omit `basisW` — same ratio of the “16” side (frameW).
 * - Live preview: pass `basisW` = `largest16x9WidthInside(prevW, prevH) * dpr` so the fill is not taken
 *   against a panel wider than 16:9 (where the fitted 16:9 viewport is narrower than clientWidth).
 */
export function recordContentFit80(
  frameW: number,
  frameH: number,
  contentW: number,
  contentH: number,
  options?: { basisW?: number; fillRatio?: number }
): { dw: number; dh: number; dx: number; dy: number } {
  const cw = Math.max(1, contentW);
  const ch = Math.max(1, contentH);
  const basisW = options?.basisW ?? frameW;
  const fill =
    typeof options?.fillRatio === "number" && options.fillRatio >= 0.5 && options.fillRatio <= 1
      ? options.fillRatio
      : 0.8;
  const targetW = Math.round(basisW * fill);
  const scale = targetW / cw;
  const dw = targetW;
  const dh = Math.round(ch * scale);
  const dx = Math.round((frameW - dw) / 2);
  const dy = Math.round((frameH - dh) / 2);
  return { dw, dh, dx, dy };
}
