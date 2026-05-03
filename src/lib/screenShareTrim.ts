/**
 * macOS “Share all application windows” often composites with L-shaped black padding
 * inside the frame. Row/column max-luma scans find where real UI begins.
 *
 * Full-screen presentation (e.g. Keynote) usually has symmetric letterboxing; trimming
 * only from the top-left then mis-crops black slides and breaks centering — we skip trim
 * when all four edges look like uniform bars, and skip horizontal trim when both sides do.
 *
 * Composite preview throttles re-detection and stabilizes results to avoid flicker.
 */

export type ScreenTrimRect = { sx: number; sy: number; sw: number; sh: number };

/**
 * Chromium exposes `displaySurface` on `getDisplayMedia` video tracks.
 * For **window** / **browser** captures, row/column luma scans mistake in-window motion (video, scrolling UI)
 * for “padding” and the inferred trim rect flips every frame → composite flicker.
 * L-shaped padding trim targets **monitor**-style captures; skip for window/tab.
 */
export function shouldSkipMacOSPaddingTrimForDisplaySurface(
  track: MediaStreamTrack | null | undefined
): boolean {
  if (!track?.getSettings) return false;
  const s = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
  const ds = s.displaySurface;
  return ds === "window" || ds === "browser";
}

/** Re-run padding detection every N composite frames (same intrinsic size). */
export const SCREEN_TRIM_REFRESH_FRAMES = 72;
/** If |Δsx|+|Δsy| is below this, keep the previous trim (reduces jitter on refresh). */
export const SCREEN_TRIM_STABLE_EPS = 14;

const SAMPLE_W = 160;
/** First row/col whose brightest pixel reaches this is treated as content edge (dark-theme UI still > ~35). */
const CONTENT_LUMA = 26;
const MAX_TRIM_FRAC = 0.48;
/**
 * Narrow bands at all four edges — if each is mostly dark, the frame is almost certainly
 * symmetric display letterboxing (e.g. Keynote full screen), not macOS “L-shaped” in-frame padding.
 * In that case top/left-only trimming mis-crops black slide margins and breaks centering.
 */
const SYMMETRIC_EDGE_BAND_FRAC = 0.05;
/** Slightly below 0.9 so H.264 edge noise doesn’t flip symmetric detection frame-to-frame. */
const SYMMETRIC_EDGE_DARK_RATIO = 0.86;

let probeCanvas: HTMLCanvasElement | null = null;

/** `videoWidth`×`videoHeight` for the current share; changes reset hysteresis. */
let trimStreamSizeKey = "";
let symmetricLetterboxLocked = false;
let symTrueStreak = 0;
let symFalseWhileLockedStreak = 0;

/** Consecutive symmetric probe reads before locking “no trim” (Keynote full screen). Use 1 so one noisy “asymmetric” frame can’t snap to L-trim between two symmetric frames. */
const SYMMETRIC_LOCK_ON_FRAMES = 1;
/** Consecutive asymmetric reads while locked before accepting trim again (noise rejection). */
const SYMMETRIC_LOCK_OFF_FRAMES = 8;

function resetSymmetricLetterboxHysteresis() {
  symmetricLetterboxLocked = false;
  symTrueStreak = 0;
  symFalseWhileLockedStreak = 0;
}

/** Call when screen share starts/stops so lock state doesn’t carry across captures. */
export function resetScreenShareTrimState() {
  trimStreamSizeKey = "";
  resetSymmetricLetterboxHysteresis();
}

function lumaAt(data: Uint8ClampedArray, cw: number, x: number, y: number): number {
  const i = (y * cw + x) * 4;
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

function edgeBandSize(cw: number, ch: number): number {
  return Math.max(2, Math.floor(Math.min(cw, ch) * SYMMETRIC_EDGE_BAND_FRAC));
}

/** Rect [x0,y1) × [y0,y1) is mostly below CONTENT_LUMA. */
function rectMostlyDark(
  data: Uint8ClampedArray,
  cw: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): boolean {
  let n = 0;
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      n++;
      if (lumaAt(data, cw, x, y) < CONTENT_LUMA) dark++;
    }
  }
  return n > 0 && dark / n >= SYMMETRIC_EDGE_DARK_RATIO;
}

/** True when all four edges of the probe are predominantly below CONTENT_LUMA (symmetric letterbox). */
function isSymmetricDarkLetterbox(data: Uint8ClampedArray, cw: number, ch: number): boolean {
  if (cw < 8 || ch < 8) return false;
  const b = edgeBandSize(cw, ch);
  return (
    rectMostlyDark(data, cw, 0, 0, cw, b) &&
    rectMostlyDark(data, cw, 0, ch - b, cw, ch) &&
    rectMostlyDark(data, cw, 0, 0, b, ch) &&
    rectMostlyDark(data, cw, cw - b, 0, cw, ch)
  );
}

/** Left and right strips both dark — likely horizontal letterbox; do not trim X (avoids eating black slide margins). */
function horizontalLetterboxBothSidesDark(data: Uint8ClampedArray, cw: number, ch: number): boolean {
  if (cw < 8 || ch < 8) return false;
  const b = edgeBandSize(cw, ch);
  return rectMostlyDark(data, cw, 0, 0, b, ch) && rectMostlyDark(data, cw, cw - b, 0, cw, ch);
}

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
  const sizeKey = `${sw}x${sh}`;
  if (sizeKey !== trimStreamSizeKey) {
    trimStreamSizeKey = sizeKey;
    resetSymmetricLetterboxHysteresis();
  }
  try {
    const cw = SAMPLE_W;
    const ch = Math.max(32, Math.round((SAMPLE_W * sh) / sw));
    const c = getProbeCanvas(cw, ch);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { sx: 0, sy: 0, sw, sh };
    ctx.drawImage(video, 0, 0, sw, sh, 0, 0, cw, ch);
    const { data } = ctx.getImageData(0, 0, cw, ch);
    const sym = isSymmetricDarkLetterbox(data, cw, ch);

    if (sym) {
      symTrueStreak = Math.min(symTrueStreak + 1, SYMMETRIC_LOCK_ON_FRAMES + 2);
      symFalseWhileLockedStreak = 0;
      if (symTrueStreak >= SYMMETRIC_LOCK_ON_FRAMES) symmetricLetterboxLocked = true;
      return { sx: 0, sy: 0, sw, sh };
    }

    symTrueStreak = 0;
    if (symmetricLetterboxLocked) {
      symFalseWhileLockedStreak++;
      if (symFalseWhileLockedStreak >= SYMMETRIC_LOCK_OFF_FRAMES) {
        symmetricLetterboxLocked = false;
        symFalseWhileLockedStreak = 0;
      } else {
        return { sx: 0, sy: 0, sw, sh };
      }
    }
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
    if (horizontalLetterboxBothSidesDark(data, cw, ch)) {
      sx = 0;
    }

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
