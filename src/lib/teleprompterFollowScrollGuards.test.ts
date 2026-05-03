import { describe, expect, it } from "vitest";
import {
  FOLLOW_READ_LARGE_GAP_MAX_STEP_PX,
  followReadBottomUrgencyBoost,
  followReadLineAnchorScrollStep,
  followReadScrollTopLerp,
  followReadScrollUpGapComfortBand,
  isCollapsedLayout,
  shouldBlockFollowJumpToTop,
  shouldBlockFollowJumpToTopMid,
  shouldResetFollowAnchorSmooth,
  shouldRestoreFollowScrollTop,
} from "./teleprompterFollowScrollGuards";

describe("teleprompterFollowScrollGuards", () => {
  describe("isCollapsedLayout", () => {
    it("detects collapse before prevStable reaches 120 (early follow read)", () => {
      expect(isCollapsedLayout(80, 18)).toBe(true);
      expect(isCollapsedLayout(48, 19)).toBe(true);
      expect(isCollapsedLayout(40, 10)).toBe(false);
    });
  });

  describe("shouldRestoreFollowScrollTop (log 6bad53 fv 44 + ghost scrollTop)", () => {
    it("restores when scrollTop is ghost 0, lastGood high, fv 44, healthy height", () => {
      expect(
        shouldRestoreFollowScrollTop({
          scrollTop: 0,
          lastGoodScrollTop: 101,
          rawMaxS: 6667,
          prevStable: 6667,
          followVis: 44,
        }),
      ).toBe(true);
    });

    it("does not restore ghost path when fv below min (opening)", () => {
      expect(
        shouldRestoreFollowScrollTop({
          scrollTop: 0,
          lastGoodScrollTop: 101,
          rawMaxS: 6667,
          prevStable: 6667,
          followVis: 8,
        }),
      ).toBe(false);
    });
  });

  describe("shouldBlockFollowJumpToTopMid (弹回第一行 gap)", () => {
    it("blocks cur~101 target~0 when fv past opening (regression)", () => {
      const cur = 101;
      const target = 0;
      const delta = target - cur;
      expect(shouldBlockFollowJumpToTopMid(cur, target, 44, delta)).toBe(true);
    });

    it("does not block legitimate small upward correction", () => {
      const cur = 101;
      const target = 55;
      const delta = target - cur;
      expect(shouldBlockFollowJumpToTopMid(cur, target, 44, delta)).toBe(false);
    });

    it("does not block when fv still low", () => {
      const cur = 101;
      const target = 0;
      const delta = -101;
      expect(shouldBlockFollowJumpToTopMid(cur, target, 20, delta)).toBe(false);
    });
  });

  describe("shouldBlockFollowJumpToTop (deep doc)", () => {
    it("blocks only when cur deep and fv very high", () => {
      expect(shouldBlockFollowJumpToTop(300, 50, 200)).toBe(true);
      expect(shouldBlockFollowJumpToTop(101, 0, 44)).toBe(false);
    });
  });

  describe("shouldResetFollowAnchorSmooth", () => {
    it("resets when raw line jumps down >10% viewport vs smoothed", () => {
      expect(shouldResetFollowAnchorSmooth(100, 115, 100)).toBe(true);
      expect(shouldResetFollowAnchorSmooth(100, 109, 100)).toBe(false);
      expect(shouldResetFollowAnchorSmooth(null, 200, 100)).toBe(false);
    });
  });

  describe("followReadLineAnchorScrollStep", () => {
    it("flags large gap but caps move per frame (no 600px snap)", () => {
      const r = followReadLineAnchorScrollStep({
        gapPx: 500,
        viewportHeightPx: 400,
        maxStepPx: 200,
        urgency: 1,
      });
      expect(r.largeGap).toBe(true);
      expect(r.movePx).toBeLessThanOrEqual(FOLLOW_READ_LARGE_GAP_MAX_STEP_PX);
      expect(r.movePx).toBeLessThanOrEqual(500);
    });

    it("does not raise per-frame cap for huge gaps (catch-up uses many frames)", () => {
      const r = followReadLineAnchorScrollStep({
        gapPx: 900,
        viewportHeightPx: 400,
        maxStepPx: 400,
        urgency: 2,
      });
      expect(r.largeGap).toBe(true);
      expect(r.movePx).toBeLessThanOrEqual(FOLLOW_READ_LARGE_GAP_MAX_STEP_PX);
      expect(r.movePx).toBeLessThanOrEqual(900);
    });

    it("keeps proportional move when gap is small", () => {
      /* FOLLOW_READ_LARGE_GAP_FRAC 0.085 → 400*0.085=34; gap must stay ≤ that band to stay “small”. */
      const r = followReadLineAnchorScrollStep({
        gapPx: 32,
        viewportHeightPx: 400,
        maxStepPx: 200,
        urgency: 0.5,
      });
      expect(r.largeGap).toBe(false);
      expect(r.movePx).toBeLessThan(32);
    });
  });

  describe("followReadScrollUpGapComfortBand", () => {
    it("returns 0 when line center is at or above band max edge", () => {
      const vpTop = 100;
      const vh = 400;
      const bandFrac = 0.42;
      const maxY = vpTop + vh * bandFrac;
      expect(
        followReadScrollUpGapComfortBand({
          lineCenterY: maxY - 5,
          rawCenterY: maxY - 5,
          viewportTop: vpTop,
          viewportHeightPx: vh,
          bandMaxFrac: bandFrac,
          hysteresisPx: 0,
        }),
      ).toBe(0);
    });

    it("returns scroll-up gap when line drifts below band max (minus hysteresis)", () => {
      const vpTop = 100;
      const vh = 400;
      const bandFrac = 0.42;
      const maxY = vpTop + vh * bandFrac;
      const line = maxY + 50;
      expect(
        followReadScrollUpGapComfortBand({
          lineCenterY: line,
          rawCenterY: line,
          viewportTop: vpTop,
          viewportHeightPx: vh,
          bandMaxFrac: bandFrac,
          hysteresisPx: 10,
        }),
      ).toBe(40);
    });
  });

  describe("followReadBottomUrgencyBoost", () => {
    it("returns 0 when raw line is above bottom danger zone", () => {
      expect(
        followReadBottomUrgencyBoost({
          rawCenterY: 200,
          viewportTop: 100,
          viewportBottom: 500,
          bottomDangerFrac: 0.2,
        }),
      ).toBe(0);
    });

    it("returns positive boost when raw line is deep in bottom strip", () => {
      const b = followReadBottomUrgencyBoost({
        rawCenterY: 490,
        viewportTop: 100,
        viewportBottom: 500,
        bottomDangerFrac: 0.2,
      });
      expect(b).toBeGreaterThan(0.5);
      expect(b).toBeLessThanOrEqual(1.25);
    });
  });

  describe("followReadScrollTopLerp", () => {
    it("applies low alpha on large gap so motion is a slide, not a snap", () => {
      const next = followReadScrollTopLerp(100, 5000, 200, true, 1);
      expect(next).toBeGreaterThan(100);
      expect(next).toBeLessThan(180);
    });

    it("eases more on small gap", () => {
      const next = followReadScrollTopLerp(100, 5000, 40, false, 0.5);
      expect(next).toBeGreaterThan(100);
      expect(next).toBeLessThan(120);
    });

    it("clamps to maxScrollTop", () => {
      const next = followReadScrollTopLerp(90, 100, 50, true, 1);
      expect(next).toBeLessThanOrEqual(100);
    });
  });
});
