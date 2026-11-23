import { describe, expect, it } from "vitest";
import {
  SPLIT_HANDLE_PX,
  SPLIT_STRIP_MIN_PX,
  computeMaxSplitStripWidth,
  computeSplitDragStripWidth,
  resolveExitSqueezeStripWidth,
  splitGridTemplate,
} from "./splitPaneLayout";

describe("splitPaneLayout", () => {
  it("enforces 40px minimum strip width in grid templates", () => {
    expect(SPLIT_STRIP_MIN_PX).toBe(40);
    expect(splitGridTemplate(10, true)).toBe("40px minmax(14px,14px) minmax(0,1fr)");
    expect(splitGridTemplate(10, false)).toBe("minmax(40px, 1fr) minmax(14px,14px) minmax(40px,40px)");
    expect(splitGridTemplate(Number.NaN, false)).toBe(
      "minmax(40px, 1fr) minmax(14px,14px) minmax(40px,40px)"
    );
  });

  it("allows dragging right-to-left until the left pane reaches exactly 40px (wb-main mode)", () => {
    const contentWidth = 1200;
    const maxStrip = computeMaxSplitStripWidth(contentWidth);
    expect(maxStrip).toBe(1200 - SPLIT_HANDLE_PX - 40);

    // Drag divider far left (negative dx widens right strip in wb-main mode)
    const next = computeSplitDragStripWidth({
      startStripWidth: 40,
      dx: -2000,
      captureMain: false,
      contentWidth,
    });
    expect(next).toBe(1146);
    expect(contentWidth - SPLIT_HANDLE_PX - next).toBe(40);
  });

  it("allows dragging left-to-right until the right pane reaches exactly 40px (capture-main mode)", () => {
    const contentWidth = 1200;
    const next = computeSplitDragStripWidth({
      startStripWidth: 40,
      dx: 2000,
      captureMain: true,
      contentWidth,
    });
    expect(next).toBe(1146);
    expect(contentWidth - SPLIT_HANDLE_PX - next).toBe(40);
  });

  it("allows dragging left back to 40px whiteboard strip in capture-main mode", () => {
    const contentWidth = 1200;
    const next = computeSplitDragStripWidth({
      startStripWidth: 1146,
      dx: -2000,
      captureMain: true,
      contentWidth,
    });
    expect(next).toBe(40);
  });

  it("preserves exact divider position when exiting squeezed whiteboard mode (no snap-back)", () => {
    const contentWidth = 1200;
    // User dragged whiteboard back from 40px to 260px and released
    const rightStrip = resolveExitSqueezeStripWidth({
      draggedLeftStripWidth: 260,
      contentWidth,
    });
    expect(rightStrip).toBe(1200 - SPLIT_HANDLE_PX - 260);
    // Left pane width after switching back to wb-main mode equals 260px
    expect(contentWidth - SPLIT_HANDLE_PX - rightStrip).toBe(260);
  });

  it("clamps cleanly on very narrow containers", () => {
    expect(computeMaxSplitStripWidth(60)).toBe(40);
    expect(
      resolveExitSqueezeStripWidth({
        draggedLeftStripWidth: 50,
        contentWidth: 60,
      })
    ).toBe(40);
  });
});
