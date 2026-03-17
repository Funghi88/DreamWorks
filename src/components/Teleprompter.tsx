import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlassButton } from "@/components/Glass";

interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TeleprompterOverlayProps {
  isVisible: boolean;
  script: string;
  isPlaying: boolean;
  speed: number;
  fontSize: number;
  opacity: number;
  overlayWidth: number;
  nearCamera: boolean;
  anchorRect: AnchorRect | null;
  position: { x: number; y: number } | null;
  locked: boolean;
  resetSignal: number;
  onSetPlaying: (playing: boolean) => void;
  onPositionChange: (position: { x: number; y: number }) => void;
  onDragStart: () => void;
  onToggleLocked: () => void;
  onReset: () => void;
  onHide: () => void;
  onNudgeSpeed: (delta: number) => void;
}

interface TeleprompterPanelProps {
  isVisible: boolean;
  isPlaying: boolean;
  script: string;
  speed: number;
  fontSize: number;
  opacity: number;
  overlayWidth: number;
  nearCamera: boolean;
  locked: boolean;
  position: { x: number; y: number } | null;
  onSetScript: (value: string) => void;
  onSetPlaying: (playing: boolean) => void;
  onSetSpeed: (value: number) => void;
  onSetFontSize: (value: number) => void;
  onSetOpacity: (value: number) => void;
  onSetOverlayWidth: (value: number) => void;
  onSetNearCamera: (value: boolean) => void;
  onPositionChange: (position: { x: number; y: number }) => void;
  onToggleLocked: () => void;
  onReset: () => void;
  onHide: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function getViewportSize() {
  if (typeof window === "undefined") return { width: 1280, height: 720 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function useTeleprompterScroll({
  isVisible,
  isPlaying,
  speed,
  script,
  onSetPlaying,
}: {
  isVisible: boolean;
  isPlaying: boolean;
  speed: number;
  script: string;
  onSetPlaying: (playing: boolean) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPx, setScrollPx] = useState(0);
  const lastTsRef = useRef<number | null>(null);

  const maxScrollPx = useMemo(() => {
    const viewport = viewportRef.current;
    if (!viewport) return 0;
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }, [script, scrollPx]);

  useEffect(() => {
    if (!isVisible || !isPlaying) return;
    let raf = 0;
    const tick = (ts: number) => {
      const prevTs = lastTsRef.current ?? ts;
      const dt = (ts - prevTs) / 1000;
      lastTsRef.current = ts;
      setScrollPx((prev) => {
        const next = prev + speed * dt;
        if (next >= maxScrollPx) {
          onSetPlaying(false);
          return maxScrollPx;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      lastTsRef.current = null;
    };
  }, [isVisible, isPlaying, speed, maxScrollPx, onSetPlaying]);

  useEffect(() => {
    setScrollPx(0);
    lastTsRef.current = null;
  }, [script]);

  const reset = () => {
    setScrollPx(0);
    lastTsRef.current = null;
  };

  return { viewportRef, scrollPx, reset };
}

export function TeleprompterOverlay({
  isVisible,
  script,
  isPlaying,
  speed,
  fontSize,
  opacity,
  overlayWidth,
  nearCamera,
  anchorRect,
  position,
  locked,
  resetSignal,
  onSetPlaying,
  onPositionChange,
  onDragStart,
  onToggleLocked,
  onReset,
  onHide,
  onNudgeSpeed,
}: TeleprompterOverlayProps) {
  const draggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const livePosRef = useRef<{ x: number; y: number } | null>(null);
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);

  const { viewportRef, scrollPx, reset } = useTeleprompterScroll({
    isVisible,
    isPlaying,
    speed,
    script,
    onSetPlaying,
  });

  useEffect(() => {
    if (!isVisible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === " ") {
        e.preventDefault();
        onSetPlaying(!isPlaying);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onNudgeSpeed(8);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onNudgeSpeed(-8);
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        reset();
        onReset();
      } else if (e.key.toLowerCase() === "h" || e.key === "Escape") {
        e.preventDefault();
        onHide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isVisible, isPlaying, onSetPlaying, onNudgeSpeed, onReset, onHide, reset]);

  useEffect(() => {
    reset();
  }, [resetSignal, reset]);

  if (!isVisible) return null;

  const clampedWidth = Math.max(320, Math.min(900, overlayWidth));
  const viewport = getViewportSize();
  const baseLeft = (viewport.width - clampedWidth) / 2;
  const nearCameraLeft = anchorRect
    ? Math.max(12, Math.min(viewport.width - clampedWidth - 12, anchorRect.left + anchorRect.width / 2 - clampedWidth / 2))
    : baseLeft;
  const nearCameraTop = anchorRect
    ? Math.max(10, Math.min(viewport.height - 220, anchorRect.top + anchorRect.height + 12))
    : 24;
  const defaultLeft = nearCamera && anchorRect ? nearCameraLeft : baseLeft;
  const defaultTop = nearCamera && anchorRect ? nearCameraTop : 24;
  const left = (livePos ?? position)?.x ?? defaultLeft;
  const top = (livePos ?? position)?.y ?? defaultTop;

  useEffect(() => {
    if (draggingRef.current) return;
    setLivePos(position);
    livePosRef.current = position;
  }, [position]);

  const onDragPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    draggingRef.current = true;
    onDragStart();
    const start = livePosRef.current ?? position ?? { x: defaultLeft, y: defaultTop };
    setLivePos(start);
    livePosRef.current = start;
    dragOffsetRef.current = { x: e.clientX - start.x, y: e.clientY - start.y };
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const vp = getViewportSize();
      const x = Math.max(8, Math.min(vp.width - clampedWidth - 8, ev.clientX - dragOffsetRef.current.x));
      const y = Math.max(8, Math.min(vp.height - 210 - 8, ev.clientY - dragOffsetRef.current.y));
      const next = { x, y };
      livePosRef.current = next;
      setLivePos(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      if (livePosRef.current) onPositionChange(livePosRef.current);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      data-dreamwork-no-intercept
      className="fixed z-[100001] overflow-hidden rounded-xl border border-white/30 bg-black/60 shadow-2xl backdrop-blur-sm"
      style={{ width: clampedWidth, maxWidth: "calc(100vw - 24px)", height: 210, left, top, opacity }}
      aria-hidden
    >
      <div
        className={`absolute inset-x-0 top-0 z-20 h-8 border-b border-white/20 bg-black/30 ${locked ? "cursor-not-allowed" : "cursor-grab"}`}
        onPointerDown={onDragPointerDown}
      />
      <button
        type="button"
        onClick={onToggleLocked}
        className="absolute right-2 top-1.5 z-30 rounded border border-white/30 bg-black/50 px-1.5 py-0.5 text-[10px] text-white/90"
        title={locked ? "Unlock teleprompter drag" : "Lock teleprompter position"}
      >
        {locked ? "Locked" : "Lock"}
      </button>
      <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/80 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-12 -translate-y-1/2 border-y border-emerald-300/40 bg-emerald-200/10" />
      <div ref={viewportRef} className="h-full overflow-hidden px-6 py-7 text-center text-white/95">
        <div style={{ fontSize, lineHeight: 1.55, transform: `translateY(${-scrollPx}px)` }}>
          <div style={{ paddingTop: "42%", paddingBottom: "42%", whiteSpace: "pre-wrap" }}>
            {script || "Paste your script in Teleprompter panel."}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TeleprompterPanel({
  isVisible,
  isPlaying,
  script,
  speed,
  fontSize,
  opacity,
  overlayWidth,
  nearCamera,
  locked,
  position,
  onSetScript,
  onSetPlaying,
  onSetSpeed,
  onSetFontSize,
  onSetOpacity,
  onSetOverlayWidth,
  onSetNearCamera,
  onPositionChange,
  onToggleLocked,
  onReset,
  onHide,
}: TeleprompterPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const idleTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const panelLivePosRef = useRef<{ x: number; y: number } | null>(null);
  const [panelLivePos, setPanelLivePos] = useState<{ x: number; y: number } | null>(null);

  const expandedWidth = 360;
  const expandedHeight = 420;
  const collapsedWidth = 230;
  const collapsedHeight = 44;
  const viewport = getViewportSize();

  const defaultPos = {
    x: Math.max(8, viewport.width - expandedWidth - 16),
    y: Math.max(8, viewport.height - expandedHeight - 16),
  };
  const left = (panelLivePos ?? position)?.x ?? defaultPos.x;
  const top = (panelLivePos ?? position)?.y ?? defaultPos.y;

  useEffect(() => {
    if (draggingRef.current) return;
    setPanelLivePos(position);
    panelLivePosRef.current = position;
  }, [position]);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setCollapsed(true), 15000);
  }, []);

  const onPanelActivity = useCallback(() => {
    if (collapsed) return;
    resetIdleTimer();
  }, [collapsed, resetIdleTimer]);

  useEffect(() => {
    if (!isVisible) return;
    setCollapsed(false);
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [isVisible, resetIdleTimer]);

  const onPanelDragDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    const panelEl = panelRef.current;
    if (!panelEl) return;
    e.preventDefault();
    if (!collapsed) resetIdleTimer();
    const rect = panelEl.getBoundingClientRect();
    draggingRef.current = true;
    const start = panelLivePosRef.current ?? position ?? { x: rect.left, y: rect.top };
    setPanelLivePos(start);
    panelLivePosRef.current = start;
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const width = collapsed ? collapsedWidth : expandedWidth;
      const height = collapsed ? collapsedHeight : expandedHeight;
      const vp = getViewportSize();
      const x = Math.max(8, Math.min(vp.width - width - 8, ev.clientX - dragOffsetRef.current.x));
      const y = Math.max(8, Math.min(vp.height - height - 8, ev.clientY - dragOffsetRef.current.y));
      const next = { x, y };
      panelLivePosRef.current = next;
      setPanelLivePos(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      if (panelLivePosRef.current) onPositionChange(panelLivePosRef.current);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  if (!isVisible) return null;
  if (collapsed) {
    return (
      <div
        ref={panelRef}
        data-dreamwork-no-intercept
        className="fixed z-[100002] flex h-11 w-[260px] items-center justify-between rounded-xl border border-white/30 bg-black/75 px-2 text-xs text-white shadow-2xl backdrop-blur-md"
        style={{ left, top }}
      >
        <div
          className={`mr-2 h-7 w-8 rounded border border-white/25 bg-black/45 text-center leading-7 ${locked ? "cursor-not-allowed" : "cursor-grab"}`}
          onPointerDown={onPanelDragDown}
          title={locked ? "Position locked" : "Drag panel"}
        >
          ::
        </div>
        <span className="mr-auto text-[11px] text-white/80">Teleprompter</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px]"
            onClick={() => onSetPlaying(!isPlaying)}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px]"
            onClick={() => {
              setCollapsed(false);
              resetIdleTimer();
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px]"
            onClick={onHide}
          >
            Hide
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      data-dreamwork-no-intercept
      className="fixed z-[100002] w-[360px] rounded-xl border border-white/30 bg-black/70 p-3 text-xs text-white shadow-2xl backdrop-blur-md"
      style={{ left, top }}
      onPointerDown={onPanelActivity}
      onKeyDown={onPanelActivity}
    >
      <div className="mb-2 flex items-center gap-2">
        <div
          className={`h-7 w-8 shrink-0 rounded border border-white/25 bg-black/45 text-center leading-7 ${locked ? "cursor-not-allowed" : "cursor-grab"}`}
          onPointerDown={onPanelDragDown}
          title={locked ? "Position locked" : "Drag panel"}
        >
          ::
        </div>
        <span className="mr-auto font-semibold">Teleprompter</span>
        <button
          type="button"
          onClick={onToggleLocked}
          className="shrink-0 rounded border border-white/30 bg-black/45 px-1.5 py-0.5 text-[10px]"
          title={locked ? "Unlock teleprompter drag" : "Lock teleprompter position"}
        >
          {locked ? "Locked" : "Lock"}
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        <GlassButton size="sm" variant={isPlaying ? "primary" : "secondary"} onClick={() => onSetPlaying(!isPlaying)}>
          {isPlaying ? "Pause" : "Play"}
        </GlassButton>
        <GlassButton size="sm" variant="secondary" onClick={onReset}>
          Reset
        </GlassButton>
        <GlassButton size="sm" variant="secondary" onClick={() => setCollapsed(true)}>
          Min
        </GlassButton>
        <GlassButton size="sm" variant="ghost" onClick={onHide}>
          Hide
        </GlassButton>
      </div>
      <textarea
        value={script}
        onChange={(e) => onSetScript(e.target.value)}
        className="mb-3 h-36 w-full resize-y rounded-md border border-white/20 bg-black/45 p-2 text-xs text-white outline-none"
        placeholder="Paste script here..."
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <label className="flex flex-col gap-1">
          <span>Speed: {Math.round(speed)} px/s</span>
          <input type="range" min={10} max={180} step={2} value={speed} onChange={(e) => onSetSpeed(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1">
          <span>Font: {Math.round(fontSize)} px</span>
          <input type="range" min={18} max={52} step={1} value={fontSize} onChange={(e) => onSetFontSize(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1">
          <span>Opacity: {opacity.toFixed(2)}</span>
          <input type="range" min={0.35} max={1} step={0.01} value={opacity} onChange={(e) => onSetOpacity(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1">
          <span>Width: {Math.round(overlayWidth)} px</span>
          <input
            type="range"
            min={320}
            max={900}
            step={10}
            value={overlayWidth}
            onChange={(e) => onSetOverlayWidth(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="mt-2 flex items-center gap-2">
        <input type="checkbox" checked={nearCamera} onChange={(e) => onSetNearCamera(e.target.checked)} />
        <span>Near camera</span>
      </label>
      <p className="mt-2 text-[11px] text-white/70">Shortcuts: Space play/pause, Up/Down speed, R reset, H hide</p>
    </div>
  );
}
