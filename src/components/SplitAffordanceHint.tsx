import { useEffect, useState, type ReactNode } from "react";
import { GlassButton } from "@/components/Glass";

/**
 * Collapsed-split affordance hints. UX:
 * - Smooth enter/exit (no mount pop).
 * - No auto-dismiss — stays visible while `show`.
 * - `minStrip`: pane at 40px min width — full-bleed cover (no margin/padding) like a stable “door” over the strip.
 * - Radius matches panels: Excalidraw 12px (`rounded-xl`), Capture 16px (`rounded-2xl`). Min strip uses the same **full** radius as the column (all corners) — asymmetric radius caused visible sharp corners vs parent.
 * - Staggered line reveal; respects `prefers-reduced-motion` (no stagger, longer dwell).
 */
type Props = {
  show: boolean;
  variant: "excalidraw" | "screen";
  /** Strip is at minimum (40px): edge-to-edge, no inset padding */
  minStrip?: boolean;
  /**
   * `variant="screen"` only: capture column is the wide `1fr` pane (Share Window, horizontal)
   * vs the narrow strip beside the main whiteboard (Drag Screen, vertical + arrow).
   */
  screenLayout?: "strip" | "main";
  /** When `screenLayout="main"`, triggers the same flow as the header “Capture Screen” (picker / share UI). */
  onCaptureScreen?: () => void;
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const fn = () => setReduced(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return reduced;
}

export function SplitAffordanceHint({
  show,
  variant,
  minStrip = false,
  screenLayout = "strip",
  onCaptureScreen,
}: Props) {
  const isExcalidraw = variant === "excalidraw";
  const isScreenMain = variant === "screen" && screenLayout === "main";
  const reduceMotion = usePrefersReducedMotion();
  const visible = show;
  /** Match parent strip: narrow columns are still full `rounded-*` boxes (see App.tsx sector-card / capture panel). */
  const radiusClass = isExcalidraw ? "rounded-xl" : "rounded-2xl";

  if (isScreenMain) {
    return (
      <div
        role="presentation"
        aria-hidden={!visible}
        className={[
          "absolute inset-0 z-[60] flex flex-row items-center justify-center pointer-events-none isolate overflow-hidden rounded-2xl",
          reduceMotion ? "transition-opacity duration-200" : "transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
          visible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-[0.97]",
        ].join(" ")}
      >
        {onCaptureScreen ? (
          <GlassButton
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-events-auto shrink-0 !border !border-white/35 !bg-black/50 !text-white shadow-md backdrop-blur-md transition-colors hover:!bg-black/65 hover:!border-white/45 font-medium"
            disabled={!visible}
            onClick={() => onCaptureScreen()}
            aria-label="Capture screen — choose a window or display to share"
          >
            Capture Screen
          </GlassButton>
        ) : (
          <span
            className="select-none text-sm font-medium tracking-tight text-white/90"
            style={{
              transitionProperty: reduceMotion ? "opacity" : "opacity, transform",
              transitionDuration: reduceMotion ? "120ms" : visible ? "420ms" : "220ms",
              transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
              opacity: visible ? 1 : 0,
              transform: reduceMotion ? "none" : visible ? "translateY(0)" : "translateY(6px)",
            }}
          >
            Capture Screen
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      role="presentation"
      aria-hidden={!visible}
      className={[
        "absolute z-[60] flex flex-col items-center justify-center pointer-events-none isolate",
        minStrip ? "overflow-visible" : "overflow-hidden",
        minStrip
          ? `inset-0 m-0 box-border h-full w-full gap-0 p-0 ${radiusClass}`
          : `inset-0 gap-0.5 m-1 p-1 ${radiusClass}`,
        reduceMotion
          ? "transition-opacity duration-200"
          : "transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
        visible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-[0.97]",
        isExcalidraw
          ? "bg-slate-50/88 backdrop-blur-[4px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.045)]"
          : "bg-slate-950/72 backdrop-blur-sm",
      ].join(" ")}
    >
      <HintLine
        visible={visible}
        delayMs={reduceMotion ? 0 : 0}
        reduceMotion={reduceMotion}
        className={`${minStrip ? "" : "truncate "} ${minStrip ? "text-[8px] leading-tight" : "text-[9px]"} ${isExcalidraw ? "text-slate-500" : "text-slate-400"}`}
      >
        {isExcalidraw ? "drag" : "Drag"}
      </HintLine>
      <HintLine
        visible={visible}
        delayMs={reduceMotion ? 0 : 70}
        reduceMotion={reduceMotion}
        className={`${minStrip ? "" : "truncate "}font-medium ${minStrip ? "text-[8px] leading-tight" : "text-[9px]"} ${isExcalidraw ? "text-slate-700" : "text-slate-200"}`}
      >
        {isExcalidraw ? "Excalidraw" : "Screen"}
      </HintLine>
      <HintLine
        visible={visible}
        delayMs={reduceMotion ? 0 : 140}
        reduceMotion={reduceMotion}
        className={`${minStrip ? "text-[10px] leading-none" : "text-sm"} ${isExcalidraw ? "text-slate-500" : "text-slate-300"}`}
        aria-hidden
      >
        {isExcalidraw ? "→" : "←"}
      </HintLine>
    </div>
  );
}

function HintLine({
  visible,
  delayMs,
  reduceMotion,
  className,
  children,
  "aria-hidden": ariaHidden,
}: {
  visible: boolean;
  delayMs: number;
  reduceMotion: boolean;
  className: string;
  children: ReactNode;
  "aria-hidden"?: boolean;
}) {
  return (
    <span
      aria-hidden={ariaHidden}
      style={{
        writingMode: "vertical-rl",
        textOrientation: "mixed",
        transitionProperty: reduceMotion ? "opacity" : "opacity, transform",
        transitionDuration: reduceMotion ? "120ms" : visible ? "420ms" : "220ms",
        transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        transitionDelay: visible && !reduceMotion ? `${delayMs}ms` : "0ms",
        opacity: visible ? 1 : 0,
        transform: reduceMotion ? "none" : visible ? "translateY(0)" : "translateY(6px)",
      }}
      className={className}
    >
      {children}
    </span>
  );
}
