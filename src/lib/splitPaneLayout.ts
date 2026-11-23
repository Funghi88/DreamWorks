/** Side strip (shared: left whiteboard / wb-only: right capture) — never narrower than this. */
export const SPLIT_STRIP_MIN_PX = 40;
/** Width of the horizontal resize handle track (px). */
export const SPLIT_HANDLE_PX = 14;
export const SPLIT_HANDLE_TRACK = `minmax(${SPLIT_HANDLE_PX}px,${SPLIT_HANDLE_PX}px)`;

/**
 * Tri-pane grid: **which column is main (1fr)** is `isScreenShareLayout` (`hasScreen` or squeeze) — not decided by drag.
 * **stripPx** is only the **narrow column width** (drag handle); main column takes the rest. Min `SPLIT_STRIP_MIN_PX`.
 */
export function splitGridTemplate(stripPx: number, isScreenShareLayout: boolean): string {
  const px = Math.max(SPLIT_STRIP_MIN_PX, Math.round(Number.isFinite(stripPx) ? stripPx : SPLIT_STRIP_MIN_PX));
  const stripTrack = `minmax(${px}px,${px}px)`;
  const wbMainFirst = `minmax(${SPLIT_STRIP_MIN_PX}px, 1fr)`;
  return isScreenShareLayout
    ? `${px}px ${SPLIT_HANDLE_TRACK} minmax(0,1fr)`
    : `${wbMainFirst} ${SPLIT_HANDLE_TRACK} ${stripTrack}`;
}

/**
 * Maximum width of the fixed strip column so the opposite column stays at least `SPLIT_STRIP_MIN_PX`.
 */
export function computeMaxSplitStripWidth(contentWidth: number, fallbackWindowWidth = 1280): number {
  if (Number.isFinite(contentWidth) && contentWidth > 0) {
    return Math.max(SPLIT_STRIP_MIN_PX, Math.round(contentWidth - SPLIT_HANDLE_PX - SPLIT_STRIP_MIN_PX));
  }
  return Math.max(600, Math.round(fallbackWindowWidth - 480));
}

/**
 * Compute clamped strip width during horizontal divider drag.
 * When `captureMain` is true, the strip is on the left (`+dx` widens it);
 * otherwise the strip is on the right (`-dx` widens it).
 */
export function computeSplitDragStripWidth(params: {
  startStripWidth: number;
  dx: number;
  captureMain: boolean;
  contentWidth: number;
  fallbackWindowWidth?: number;
}): number {
  const { startStripWidth, dx, captureMain, contentWidth, fallbackWindowWidth = 1280 } = params;
  const maxW = computeMaxSplitStripWidth(contentWidth, fallbackWindowWidth);
  const delta = captureMain ? dx : -dx;
  const raw = Math.round(startStripWidth + delta);
  return Math.max(
    SPLIT_STRIP_MIN_PX,
    Math.min(maxW, Number.isFinite(raw) ? raw : SPLIT_STRIP_MIN_PX)
  );
}

/**
 * Convert a dragged left-strip width back to the matching right-strip width when exiting
 * `captureMainNoStream` (whiteboard-squeezed mode), preserving the exact divider position on release.
 */
export function resolveExitSqueezeStripWidth(params: {
  draggedLeftStripWidth: number;
  contentWidth: number;
}): number {
  const { draggedLeftStripWidth, contentWidth } = params;
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) {
    return SPLIT_STRIP_MIN_PX;
  }
  const maxStrip = Math.max(SPLIT_STRIP_MIN_PX, Math.round(contentWidth - SPLIT_HANDLE_PX - SPLIT_STRIP_MIN_PX));
  const rightWidth = Math.round(contentWidth - SPLIT_HANDLE_PX - draggedLeftStripWidth);
  return Math.max(SPLIT_STRIP_MIN_PX, Math.min(maxStrip, rightWidth));
}
