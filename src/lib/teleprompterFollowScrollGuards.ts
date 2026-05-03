/**
 * Pure follow-viewport scroll guards (Teleprompter followFracScrollSync).
 * Kept testable so CI / `npm test` can catch snapback / ghost regressions without mic.
 */

export const FOLLOW_SCROLL_TOP_GHOST_LT = 42;
export const FOLLOW_SCROLL_TOP_RESTORE_LAST_GT = 72;
export const FOLLOW_GHOST_RESTORE_MIN_VIS_CHARS = 12;
export const FOLLOW_SCROLL_SNAPBACK_MIN_FV = 28;

/**
 * Transient scrollHeight collapse (decorations / ProseMirror layout) while mid-read.
 * Requires prevStable >= 48 so we have seen a real scroll range at least once; early sessions used to
 * fail the old prevStable>120 gate — rawMaxS then stayed tiny → frac*maxS≈0 → repeated jump to line 1.
 */
export function isCollapsedLayout(prevStable: number, rawMaxS: number): boolean {
  if (prevStable < 48) return false;
  return rawMaxS < Math.min(prevStable * 0.42, 78);
}

/** Restore scrollTop when ghost zero or height-collapse stale coords would otherwise explode band clamp. */
export function shouldRestoreFollowScrollTop(params: {
  scrollTop: number;
  lastGoodScrollTop: number;
  rawMaxS: number;
  prevStable: number;
  followVis: number;
}): boolean {
  const { scrollTop, lastGoodScrollTop, rawMaxS, prevStable, followVis } = params;
  const collapsedLayout = isCollapsedLayout(prevStable, rawMaxS);
  const scrollTopGhostZero =
    !collapsedLayout &&
    rawMaxS > 120 &&
    scrollTop < FOLLOW_SCROLL_TOP_GHOST_LT &&
    lastGoodScrollTop > FOLLOW_SCROLL_TOP_RESTORE_LAST_GT;
  return (
    scrollTop < FOLLOW_SCROLL_TOP_GHOST_LT &&
    lastGoodScrollTop > FOLLOW_SCROLL_TOP_RESTORE_LAST_GT &&
    ((collapsedLayout && followVis > 50) ||
      (scrollTopGhostZero && followVis >= FOLLOW_GHOST_RESTORE_MIN_VIS_CHARS))
  );
}

/** Deep scroll: block snap toward top (legacy H_JUMP). */
export function shouldBlockFollowJumpToTop(cur: number, target: number, followVis: number): boolean {
  return cur > 250 && target < 80 && followVis > 150;
}

/** Mid-range scroll: block pathological snap toward ~0 (H_JUMP_MID). */
export function shouldBlockFollowJumpToTopMid(
  cur: number,
  target: number,
  followVis: number,
  delta: number,
): boolean {
  return (
    followVis > FOLLOW_SCROLL_SNAPBACK_MIN_FV &&
    cur > 48 &&
    target < Math.min(80, cur * 0.45) &&
    delta < -28
  );
}

/** Follow-read line anchor: gap above this fraction of viewport height uses fast catch-up scroll. */
export const FOLLOW_READ_LARGE_GAP_FRAC = 0.085;

/** When the read line jumps down vs smoothed Y, drop EMA so scroll gap is not underestimated. */
export function shouldResetFollowAnchorSmooth(
  prevSmoothedY: number | null,
  rawCenterY: number,
  viewportHeightPx: number,
): boolean {
  if (prevSmoothedY == null) return false;
  const vh = Math.max(1, viewportHeightPx);
  return rawCenterY - prevSmoothedY > vh * 0.1;
}

/** Hard cap on requested scroll delta per rAF step (catch-up uses many frames, not one big jump). */
export const FOLLOW_READ_LARGE_GAP_MAX_STEP_PX = 94;

/**
 * rAF follow scroll: small gaps use proportional closure; large gaps still cap per frame so scroll
 * stays a smooth slide instead of snapping hundreds of px.
 */
export function followReadLineAnchorScrollStep(params: {
  gapPx: number;
  viewportHeightPx: number;
  maxStepPx: number;
  urgency: number;
}): { movePx: number; largeGap: boolean } {
  const { gapPx, viewportHeightPx, maxStepPx, urgency } = params;
  const vh = Math.max(1, viewportHeightPx);
  const largeGap = gapPx > vh * FOLLOW_READ_LARGE_GAP_FRAC;
  if (largeGap) {
    const maxStepLarge = Math.min(
      FOLLOW_READ_LARGE_GAP_MAX_STEP_PX,
      Math.max(maxStepPx, maxStepPx * 1.04),
    );
    return { movePx: Math.min(gapPx, maxStepLarge), largeGap: true };
  }
  const u = Math.min(1, urgency);
  /** Gentler proportional closure; paired with slightly higher lerp alpha on small gaps. */
  const moveFraction = 0.22 + 0.09 * u;
  let movePx = gapPx * moveFraction;
  movePx = Math.min(movePx, maxStepPx * (0.74 + 0.18 * u));
  return { movePx, largeGap: false };
}

/**
 * One rAF step: ease toward target scrollTop. Low alphas so motion is continuous slide, not a snap.
 */
export function followReadScrollTopLerp(
  currentScrollTop: number,
  maxScrollTop: number,
  movePx: number,
  largeGap: boolean,
  urgency: number,
): number {
  const target = Math.min(maxScrollTop, currentScrollTop + movePx);
  const u = Math.min(1, Math.max(0, urgency));
  const alpha = largeGap
    ? Math.min(0.24, 0.12 + 0.08 * u)
    : 0.1 + 0.14 * u;
  return currentScrollTop + (target - currentScrollTop) * alpha;
}

/**
 * Scroll-up gap (px) so the first-unread line stays at or above the comfort band top edge.
 * Screen Y increases downward: when line center is below `bandMaxY`, gap is positive (scroll up).
 * Hysteresis below `bandMaxY` reduces jitter near the band edge.
 */
export function followReadScrollUpGapComfortBand(params: {
  lineCenterY: number;
  rawCenterY: number;
  viewportTop: number;
  viewportHeightPx: number;
  /** Lower edge of band (fraction of viewport from top); line above this does not add scroll-up gap here. */
  bandMaxFrac: number;
  hysteresisPx: number;
}): number {
  const vh = Math.max(1, params.viewportHeightPx);
  const maxY = params.viewportTop + vh * params.bandMaxFrac;
  const line = Math.max(params.lineCenterY, params.rawCenterY);
  if (line <= maxY) return 0;
  return Math.max(0, line - maxY - params.hysteresisPx);
}

/**
 * Extra urgency when the raw read line sits in the bottom strip of the viewport (avoid “only scroll at last rows”).
 */
export function followReadBottomUrgencyBoost(params: {
  rawCenterY: number;
  viewportTop: number;
  viewportBottom: number;
  bottomDangerFrac: number;
}): number {
  const vh = Math.max(1, params.viewportBottom - params.viewportTop);
  const dangerY = params.viewportBottom - vh * params.bottomDangerFrac;
  if (params.rawCenterY <= dangerY) return 0;
  const span = Math.max(24, vh * 0.1);
  const t = Math.min(1, (params.rawCenterY - dangerY) / span);
  return t * 1.25;
}
