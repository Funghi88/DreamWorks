import { useRef, useState, type HTMLAttributes } from "react";

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  /**
   * Horizontal split only: called with pointer `clientX` after drag arms (1:1 with pointer — no delta accumulation drift).
   * When provided for `direction="horizontal"`, `onResize` is not used for moves (still used if vertical).
   */
  onResizeHorizontalClientX?: (clientX: number) => void;
  /** Fires once on pointer down (before drag arms) — reset session state in parent. */
  onResizeSessionStart?: () => void;
  /** Fires once when the pointer is released (only if drag had armed past the threshold). */
  onResizeEnd?: () => void;
  /** Always runs on pointer up / cancel / lost capture — use to clear “dragging” UI even when the drag never armed. */
  onResizePointerDone?: () => void;
  direction: "horizontal" | "vertical";
  className?: string;
  "data-dreamwork-no-intercept"?: boolean;
}

/** Match neutral shell (.glass-bg); hover/drag give contrast without pink-tint stops */
const HANDLE_HOVER = "rgba(220, 228, 238, 0.55)";
const HANDLE_DRAG = "rgba(190, 200, 216, 0.88)";

/** Ignore sub-pixel noise / fat-finger taps; keep tiny so dragging feels immediate. */
const DRAG_THRESHOLD_PX = 1;

/**
 * Split-pane resize: optional absolute clientX path for horizontal panes (smooth 1:1).
 * Uses pointer capture so move/up reliably reach this element during drag.
 */
export function ResizeHandle({
  onResize,
  onResizeHorizontalClientX,
  onResizeSessionStart,
  onResizeEnd,
  onResizePointerDone,
  direction,
  className = "",
  "data-dreamwork-no-intercept": noIntercept,
  ...rest
}: ResizeHandleProps & HTMLAttributes<HTMLDivElement>) {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizeHorizontalClientXRef = useRef(onResizeHorizontalClientX);
  onResizeHorizontalClientXRef.current = onResizeHorizontalClientX;
  const onResizeSessionStartRef = useRef(onResizeSessionStart);
  onResizeSessionStartRef.current = onResizeSessionStart;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;
  const onResizePointerDoneRef = useRef(onResizePointerDone);
  onResizePointerDoneRef.current = onResizePointerDone;
  const [isDragging, setIsDragging] = useState(false);
  const [isHover, setIsHover] = useState(false);

  const isHorizontal = direction === "horizontal";
  const useClientXPath = isHorizontal && typeof onResizeHorizontalClientX === "function";

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let lastY = startY;
    let armed = false;
    let cleaned = false;

    onResizeSessionStartRef.current?.();

    if (useClientXPath) {
      armed = true;
      setIsDragging(true);
      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      onResizeHorizontalClientXRef.current?.(startX);
    }

    try {
      el.setPointerCapture(pid);
    } catch {
      /* ignore */
    }

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      el.removeEventListener("lostpointercapture", onLostCapture);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsDragging(false);
      onResizePointerDoneRef.current?.();
      if (armed) onResizeEndRef.current?.();
    };

    const onLostCapture = () => {
      cleanup();
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;

      if (!armed) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const dist = isHorizontal ? Math.abs(dx) : Math.abs(dy);
        if (dist < DRAG_THRESHOLD_PX) return;

        armed = true;
        setIsDragging(true);
        document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";

        if (useClientXPath) {
          onResizeHorizontalClientXRef.current?.(ev.clientX);
          lastX = ev.clientX;
          lastY = ev.clientY;
          return;
        }

        if (isHorizontal) {
          const sign = dx === 0 ? 1 : Math.sign(dx);
          const edgeX = startX + sign * DRAG_THRESHOLD_PX;
          const firstDelta = ev.clientX - edgeX;
          lastX = ev.clientX;
          lastY = ev.clientY;
          if (firstDelta !== 0) onResizeRef.current(firstDelta);
        } else {
          const sign = dy === 0 ? 1 : Math.sign(dy);
          const edgeY = startY + sign * DRAG_THRESHOLD_PX;
          const firstDelta = ev.clientY - edgeY;
          lastX = ev.clientX;
          lastY = ev.clientY;
          if (firstDelta !== 0) onResizeRef.current(firstDelta);
        }
        return;
      }

      if (useClientXPath) {
        onResizeHorizontalClientXRef.current?.(ev.clientX);
        lastX = ev.clientX;
        lastY = ev.clientY;
        return;
      }

      const nx = ev.clientX;
      const ny = ev.clientY;
      const delta = isHorizontal ? nx - lastX : ny - lastY;
      lastX = nx;
      lastY = ny;
      if (delta !== 0) onResizeRef.current(delta);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      cleanup();
    };

    el.addEventListener("lostpointercapture", onLostCapture);
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    document.addEventListener("pointerup", onUp, { capture: true });
    document.addEventListener("pointercancel", onUp, { capture: true });
  };

  const innerBg = isDragging ? HANDLE_DRAG : isHover ? HANDLE_HOVER : "transparent";
  return (
    <div
      role="separator"
      aria-orientation={direction}
      onPointerDown={onPointerDown}
      data-dreamwork-no-intercept={noIntercept ? "" : undefined}
      className={`shrink-0 touch-none select-none flex items-center justify-center ${
        isHorizontal ? "w-[14px] px-1" : "h-[14px] py-1"
      } ${className} ${isDragging ? "!transition-none" : ""}`}
      style={{
        cursor: isHorizontal ? "col-resize" : "row-resize",
        backgroundColor: "#e8ecf0",
        touchAction: "none",
      }}
      onMouseEnter={() => setIsHover(true)}
      onMouseLeave={() => setIsHover(false)}
      {...rest}
    >
      <div
        className={`${isHorizontal ? "w-1.5 h-full min-h-[24px]" : "h-1.5 w-full min-w-[24px]"}`}
        style={{ backgroundColor: innerBg }}
      />
    </div>
  );
}
