import { useRef, useEffect, useState } from "react";

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  direction: "horizontal" | "vertical";
  className?: string;
  "data-dreamwork-no-intercept"?: boolean;
}

/** glass-bg purple: #e8eeff, #f5f0ff. Hover: match; dragging: more solid */
const HANDLE_HOVER = "rgba(232, 238, 255, 0.5)";
const HANDLE_DRAG = "rgba(200, 208, 240, 0.85)";

export function ResizeHandle({
  onResize,
  direction,
  className = "",
  "data-dreamwork-no-intercept": noIntercept,
  ...rest
}: ResizeHandleProps & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isHover, setIsHover] = useState(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!ref.current) return;
      onResize(direction === "horizontal" ? e.movementX : e.movementY);
    };
    const onUp = () => {
      ref.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [onResize, direction]);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    ref.current = true;
    setIsDragging(true);
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const isHorizontal = direction === "horizontal";
  const innerBg = isDragging ? HANDLE_DRAG : isHover ? HANDLE_HOVER : "transparent";
  return (
    <div
      role="separator"
      aria-orientation={direction}
      onMouseDown={onDown}
      data-dreamwork-no-intercept={noIntercept ? "" : undefined}
      className={`shrink-0 touch-none select-none flex items-center justify-center ${
        isHorizontal ? "w-[14px] px-1" : "h-[14px] py-1"
      } ${className}`}
      style={{
        cursor: isHorizontal ? "col-resize" : "row-resize",
        backgroundColor: "#e8eeff",
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
