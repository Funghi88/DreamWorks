import { recordContentFit80 } from "@/lib/recordLayout";

/** Same rounding as `drawComposite` pipMap — authoritative box is `previewRef.getBoundingClientRect()`. */
export function wbPipMapDimsFromPreviewEl(
  el: HTMLElement | null | undefined
): { pipMapW: number; pipMapH: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { pipMapW: Math.max(1, Math.round(r.width)), pipMapH: Math.max(1, Math.round(r.height)) };
}

/** Uniform encode preview → output bitmap (matches App whiteboard-record PiP mapping). */
export function wbEncodeUniformLetterbox(outW: number, outH: number, pipMapW: number, pipMapH: number) {
  const pw = Math.max(1, pipMapW);
  const ph = Math.max(1, pipMapH);
  const sx0 = outW / pw;
  const sy0 = outH / ph;
  const s = Math.min(sx0, sy0);
  const lx = (outW - pw * s) / 2;
  const ly = (outH - ph * s) / 2;
  return { s, lx, ly };
}

/** PiP DOM offset vs preview top-left (same coords as fullPagePipPos) → output pixels (top-left + size). */
export function wbRecordPipOutputRect(opts: {
  outW: number;
  outH: number;
  pipMapW: number;
  pipMapH: number;
  pipX: number;
  pipY: number;
  pipWCss: number;
  pipHCss: number;
}): { x: number; y: number; pw: number; ph: number } {
  const { s, lx, ly } = wbEncodeUniformLetterbox(opts.outW, opts.outH, opts.pipMapW, opts.pipMapH);
  /**
   * Rounding `pipWCss * s` and `pipHCss * s` independently can yield pw=0, ph≥1 when s is small and
   * pipHCss > pipWCss — minimap shows a vertical sliver; composite clip can desync from the portal.
   */
  const pw = Math.max(1, Math.round(opts.pipWCss * s));
  const ph = Math.max(1, Math.round(opts.pipHCss * s));
  return {
    x: Math.round(opts.pipX * s + lx),
    y: Math.round(opts.pipY * s + ly),
    pw,
    ph,
  };
}

/** Inverse: desired output-space PiP center → CSS position (top-left) vs preview origin. */
export function wbRecordPipCssPosFromOutputCenter(opts: {
  outW: number;
  outH: number;
  pipMapW: number;
  pipMapH: number;
  pipWCss: number;
  pipHCss: number;
  /** Desired center in output px */
  cxOut: number;
  cyOut: number;
}): { x: number; y: number } {
  const { s, lx, ly } = wbEncodeUniformLetterbox(opts.outW, opts.outH, opts.pipMapW, opts.pipMapH);
  const pwOut = opts.pipWCss * s;
  const phOut = opts.pipHCss * s;
  const ox = opts.cxOut - pwOut / 2;
  const oy = opts.cyOut - phOut / 2;
  const x = (ox - lx) / s;
  const y = (oy - ly) / s;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Whiteboard surface rectangle in output pixels (includes Share fill + optional pan inside slack). */
export function computeWhiteboardRecordingSurfacePx(
  outW: number,
  outH: number,
  iw: number,
  ih: number,
  fillRatio: number,
  surfacePanNorm: { x: number; y: number }
): { x: number; y: number; w: number; h: number } {
  const fit = recordContentFit80(outW, outH, iw, ih, { fillRatio });
  let { dx, dy, dw, dh } = fit;
  const slackX = outW - dw;
  const slackY = outH - dh;
  const px = Math.min(1, Math.max(-1, surfacePanNorm.x));
  const py = Math.min(1, Math.max(-1, surfacePanNorm.y));
  if (slackX > 1) dx = Math.round((slackX * (px + 1)) / 2);
  if (slackY > 1) dy = Math.round((slackY * (py + 1)) / 2);
  return { x: dx, y: dy, w: dw, h: dh };
}
