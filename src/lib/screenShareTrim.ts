/**
 * macOS “Share all application windows” often composites with L-shaped black padding
 * inside the frame. Row/column max-luma scans find where real UI begins.
 *
 * Composite preview throttles re-detection and stabilizes results to avoid flicker.
 */

export type ScreenTrimRect = { sx: number; sy: number; sw: number; sh: number };

/** Re-run padding detection every N composite frames (same intrinsic size). */
export const SCREEN_TRIM_REFRESH_FRAMES = 48;
/** If |Δsx|+|Δsy| is below this, keep the previous trim (reduces jitter on refresh). */
export const SCREEN_TRIM_STABLE_EPS = 10;

const SAMPLE_W = 160;
/** First row/col whose brightest pixel reaches this is treated as content edge (dark-theme UI still > ~35). */
const CONTENT_LUMA = 26;
const MAX_TRIM_FRAC = 0.48;

let probeCanvas: HTMLCanvasElement | null = null;

function getProbeCanvas(w: number, h: number): HTMLCanvasElement {
  if (!probeCanvas) probeCanvas = document.createElement("canvas");
  if (probeCanvas.width !== w || probeCanvas.height !== h) {
    probeCanvas.width = w;
    probeCanvas.height = h;
  }
  return probeCanvas;
}

/** Snap trim to a pixel grid and drop pathological crops. */
export function snapScreenTrimRect(r: ScreenTrimRect, sw0: number, sh0: number): ScreenTrimRect {
  const step = 4;
  const sx = Math.min(Math.floor(sw0 * 0.48), Math.max(0, Math.round(r.sx / step) * step));
  const sy = Math.min(Math.floor(sh0 * 0.48), Math.max(0, Math.round(r.sy / step) * step));
  const sw = sw0 - sx;
  const sh = sh0 - sy;
  if (sw < sw0 * 0.45 || sh < sh0 * 0.45) return { sx: 0, sy: 0, sw: sw0, sh: sh0 };
  return { sx, sy, sw, sh };
}

export function mergeStableScreenTrim(prev: ScreenTrimRect, next: ScreenTrimRect): ScreenTrimRect {
  const d = Math.abs(next.sx - prev.sx) + Math.abs(next.sy - prev.sy);
  if (d <= SCREEN_TRIM_STABLE_EPS) return prev;
  return next;
}

export function trimMacOSScreenSharePadding(
  video: HTMLVideoElement,
  sw: number,
  sh: number
): ScreenTrimRect {
  if (sw < 32 || sh < 32) return { sx: 0, sy: 0, sw, sh };
  try {
    const cw = SAMPLE_W;
    const ch = Math.max(32, Math.round((SAMPLE_W * sh) / sw));
    const c = getProbeCanvas(cw, ch);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { sx: 0, sy: 0, sw, sh };
    ctx.drawImage(video, 0, 0, sw, sh, 0, 0, cw, ch);
    const { data } = ctx.getImageData(0, 0, cw, ch);
    const luma = (ix: number, iy: number) => {
      const i = (iy * cw + ix) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    };
    const rowMax = (y: number) => {
      let m = 0;
      for (let x = 0; x < cw; x++) m = Math.max(m, luma(x, y));
      return m;
    };
    const colMax = (x: number) => {
      let m = 0;
      for (let y = 0; y < ch; y++) m = Math.max(m, luma(x, y));
      return m;
    };

    const maxY = Math.floor(ch * MAX_TRIM_FRAC);
    const maxX = Math.floor(cw * MAX_TRIM_FRAC);
    let ty = 0;
    for (let y = 0; y < maxY; y++) {
      if (rowMax(y) >= CONTENT_LUMA) {
        ty = y;
        break;
      }
    }
    let tx = 0;
    for (let x = 0; x < maxX; x++) {
      if (colMax(x) >= CONTENT_LUMA) {
        tx = x;
        break;
      }
    }

    let sx = Math.round((tx / cw) * sw);
    let sy = Math.round((ty / ch) * sh);
    sx = Math.max(0, Math.min(sx, Math.floor(sw * MAX_TRIM_FRAC)));
    sy = Math.max(0, Math.min(sy, Math.floor(sh * MAX_TRIM_FRAC)));

    const srw = sw - sx;
    const srh = sh - sy;
    if (srw < sw * 0.45 || srh < sh * 0.45) {
      return { sx: 0, sy: 0, sw, sh };
    }
    return { sx, sy, sw: srw, sh: srh };
  } catch {
    return { sx: 0, sy: 0, sw, sh };
  }
}
