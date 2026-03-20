import { useRef, useState, type HTMLAttributes } from "react";

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  /** Fires once when the pointer is released (only if drag had armed past the threshold). */
  onResizeEnd?: () => void;
  direction: "horizontal" | "vertical";
  className?: string;
  "data-dreamwork-no-intercept"?: boolean;
}

/** Match neutral shell (.glass-bg); hover/drag give contrast without pink-tint stops */
const HANDLE_HOVER = "rgba(220, 228, 238, 0.55)";
const HANDLE_DRAG = "rgba(190, 200, 216, 0.88)";

/**
 * Pixels the pointer must move along the resize axis before any resize runs.
 * Stops accidental drags from light clicks / trackpad taps.
 */
const DRAG_THRESHOLD_PX = 8;

function accumulatedClientDelta(
  ev: PointerEvent,
  lastX: number,
  lastY: number,
  horizontal: boolean
): { delta: number; x: number; y: number } {
  const raw = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
  let lx = lastX;
  let ly = lastY;
  let sum = 0;
  for (const c of raw) {
    if (horizontal) {
      sum += c.clientX - lx;
      lx = c.clientX;
    } else {
      sum += c.clientY - ly;
      ly = c.clientY;
    }
  }
  if (horizontal) {
    sum += ev.clientX - lx;
    lx = ev.clientX;
  } else {
    sum += ev.clientY - ly;
    ly = ev.clientY;
  }
  return { delta: sum, x: lx, y: ly };
}

/**
 * Split-pane resize: drag threshold avoids mis-clicks; `onResize` runs immediately
 * (no rAF) so the parent can update layout without waiting a frame.
 */
export function ResizeHandle({
  onResize,
  onResizeEnd,
  direction,
  className = "",
  "data-dreamwork-no-intercept": noIntercept,
  ...rest
}: ResizeHandleProps & HTMLAttributes<HTMLDivElement>) {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;
  const [isDragging, setIsDragging] = useState(false);
  const [isHover, setIsHover] = useState(false);

  const isHorizontal = direction === "horizontal";

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let lastY = startY;
    let armed = false;

    const cleanup = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsDragging(false);
      if (armed) onResizeEndRef.current?.();
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

      const { delta, x, y } = accumulatedClientDelta(ev, lastX, lastY, isHorizontal);
      lastX = x;
      lastY = y;
      if (delta !== 0) onResizeRef.current(delta);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      cleanup();
    };

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
      } ${className}`}
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
        className={`transition-colors ${isHorizontal ? "w-1.5 h-full min-h-[24px]" : "h-1.5 w-full min-w-[24px]"}`}
        style={{ backgroundColor: innerBg }}
      />
    </div>
  );
}
