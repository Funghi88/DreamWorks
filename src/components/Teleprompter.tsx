import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  overlayHeight: number;
  nearCamera: boolean;
  anchorRect: AnchorRect | null;
  position: { x: number; y: number } | null;
  locked: boolean;
  resetSignal: number;
  editorScrollRatio?: number | null;
  onSetPlaying: (playing: boolean) => void;
  onPositionChange: (position: { x: number; y: number }) => void;
  onOverlaySizeChange: (width: number, height: number) => void;
  onDragStart: () => void;
  onToggleLocked: () => void;
  onReset: () => void;
  onHide: () => void;
  onNudgeSpeed: (delta: number) => void;
}

interface TeleprompterScriptItem {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
}

interface TeleprompterPanelProps {
  isVisible: boolean;
  isPlaying: boolean;
  script: string;
  scripts: TeleprompterScriptItem[];
  activeScriptId: string;
  onSwitchScript: (id: string) => void;
  onNewScript: () => void;
  onSaveAsScript: () => void;
  onRenameScript: (newName: string) => void;
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
  onFlushSave?: () => void;
  onEditorScroll?: (ratio: number) => void;
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

function clampScroll(
  viewport: HTMLDivElement | null,
  scrollContent: HTMLDivElement | null,
  scrollPxRef: { current: number }
) {
  if (!viewport || !scrollContent) return;
  const maxScrollPx = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  scrollPxRef.current = Math.min(scrollPxRef.current, maxScrollPx);
  scrollContent.style.transform = `translateY(${-scrollPxRef.current}px)`;
}

function useTeleprompterScroll({
  isVisible,
  isPlaying,
  speed,
  script,
  fontSize,
  overlayWidth,
  overlayHeight,
  onSetPlaying,
  resetSignal,
  editorScrollRatio,
}: {
  isVisible: boolean;
  isPlaying: boolean;
  speed: number;
  script: string;
  fontSize: number;
  overlayWidth: number;
  overlayHeight: number;
  onSetPlaying: (playing: boolean) => void;
  resetSignal?: number;
  editorScrollRatio?: number | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const scrollPxRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (resetSignal != null) {
      scrollPxRef.current = 0;
      lastTsRef.current = null;
      const el = scrollContentRef.current;
      if (el) el.style.transform = "translateY(0px)";
    }
  }, [resetSignal]);

  // When script or layout (fontSize, size) changes: preserve scroll position, clamp to max
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      clampScroll(viewportRef.current, scrollContentRef.current, scrollPxRef);
    });
    return () => cancelAnimationFrame(raf);
  }, [script, fontSize, overlayWidth, overlayHeight]);

  // Sync scroll from editor (right panel) when user scrolls the textarea
  useEffect(() => {
    if (editorScrollRatio == null || typeof editorScrollRatio !== "number") return;
    const viewport = viewportRef.current;
    const el = scrollContentRef.current;
    if (!viewport || !el) return;
    const maxScrollPx = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    scrollPxRef.current = Math.max(0, Math.min(editorScrollRatio * maxScrollPx, maxScrollPx));
    el.style.transform = `translateY(${-scrollPxRef.current}px)`;
  }, [editorScrollRatio]);

  useEffect(() => {
    if (!isVisible || !isPlaying) return;
    let raf = 0;
    const tick = (ts: number) => {
      const viewport = viewportRef.current;
      const maxScrollPx = viewport ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : 0;
      const prevTs = lastTsRef.current ?? ts;
      const dt = (ts - prevTs) / 1000;
      lastTsRef.current = ts;
      const next = Math.min(scrollPxRef.current + speed * dt, maxScrollPx);
      scrollPxRef.current = next;
      const el = scrollContentRef.current;
      if (el) el.style.transform = `translateY(${-next}px)`;
      if (maxScrollPx > 0 && next >= maxScrollPx) onSetPlaying(false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      lastTsRef.current = null;
      // Preserve scroll position when pausing (cleanup runs when isPlaying becomes false)
      const el = scrollContentRef.current;
      if (el) el.style.transform = `translateY(${-scrollPxRef.current}px)`;
    };
  }, [isVisible, isPlaying, speed, onSetPlaying]);

  const reset = useCallback(() => {
    scrollPxRef.current = 0;
    lastTsRef.current = null;
    const el = scrollContentRef.current;
    if (el) el.style.transform = "translateY(0px)";
  }, []);

  const addScrollDelta = useCallback((delta: number) => {
    const viewport = viewportRef.current;
    const el = scrollContentRef.current;
    if (!viewport || !el) return;
    const maxScrollPx = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    scrollPxRef.current = Math.max(0, Math.min(scrollPxRef.current + delta, maxScrollPx));
    el.style.transform = `translateY(${-scrollPxRef.current}px)`;
  }, []);

  return { viewportRef, scrollContentRef, reset, addScrollDelta };
}

export function TeleprompterOverlay({
  isVisible,
  script,
  isPlaying,
  speed,
  fontSize,
  opacity,
  overlayWidth,
  overlayHeight,
  nearCamera,
  anchorRect,
  position,
  locked,
  resetSignal,
  editorScrollRatio,
  onSetPlaying,
  onPositionChange,
  onOverlaySizeChange,
  onDragStart,
  onToggleLocked,
  onReset,
  onHide,
  onNudgeSpeed,
}: TeleprompterOverlayProps) {
  const draggingRef = useRef(false);
  const resizingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const resizeStartRef = useRef({ width: 0, height: 0, clientX: 0, clientY: 0 });
  const livePosRef = useRef<{ x: number; y: number } | null>(null);
  const lastAnchoredPosRef = useRef<{ x: number; y: number } | null>(null);
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);

  const { viewportRef, scrollContentRef, reset, addScrollDelta } = useTeleprompterScroll({
    isVisible,
    isPlaying,
    speed,
    script,
    fontSize,
    overlayWidth,
    overlayHeight,
    onSetPlaying,
    resetSignal,
    editorScrollRatio,
  });

  const scrollDragRef = useRef(false);
  const scrollDragStartRef = useRef(0);
  const [isScrollDragging, setIsScrollDragging] = useState(false);

  const onScrollPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (locked) return;
      e.preventDefault();
      scrollDragRef.current = true;
      setIsScrollDragging(true);
      scrollDragStartRef.current = e.clientY;
      onSetPlaying(false);
      const target = e.currentTarget as HTMLElement;
      if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        if (!scrollDragRef.current) return;
        const delta = scrollDragStartRef.current - ev.clientY;
        scrollDragStartRef.current = ev.clientY;
        addScrollDelta(delta);
      };
      const onUp = () => {
        scrollDragRef.current = false;
        setIsScrollDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [locked, onSetPlaying, addScrollDelta]
  );

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
    if (resetSignal != null) reset();
  }, [resetSignal, reset]);

  const clampedWidth = Math.max(320, Math.min(900, overlayWidth));
  const clampedHeight = Math.max(180, Math.min(500, overlayHeight));
  const viewport = getViewportSize();
  const baseLeft = (viewport.width - clampedWidth) / 2;
  const nearCameraLeft = anchorRect
    ? Math.max(12, Math.min(viewport.width - clampedWidth - 12, anchorRect.left + anchorRect.width / 2 - clampedWidth / 2))
    : baseLeft;
  const nearCameraTop = anchorRect
    ? Math.max(10, Math.min(viewport.height - clampedHeight - 20, anchorRect.top + anchorRect.height + 12))
    : 24;
  const defaultLeft = nearCamera && anchorRect ? nearCameraLeft : baseLeft;
  const defaultTop = nearCamera && anchorRect ? nearCameraTop : 24;
  const rawLeft = (livePos ?? position)?.x ?? defaultLeft;
  const rawTop = (livePos ?? position)?.y ?? defaultTop;
  const preserved = !anchorRect && lastAnchoredPosRef.current;
  const left = preserved ? lastAnchoredPosRef.current!.x : rawLeft;
  const top = preserved ? lastAnchoredPosRef.current!.y : rawTop;

  useEffect(() => {
    if (anchorRect) {
      lastAnchoredPosRef.current = { x: rawLeft, y: rawTop };
    } else if (lastAnchoredPosRef.current) {
      onPositionChange(lastAnchoredPosRef.current);
      lastAnchoredPosRef.current = null;
    }
  }, [anchorRect, rawLeft, rawTop, onPositionChange]);

  useEffect(() => {
    if (draggingRef.current) return;
    setLivePos(position);
    livePosRef.current = position;
  }, [position]);

  if (!isVisible) return null;

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
      const y = Math.max(8, Math.min(vp.height - clampedHeight - 8, ev.clientY - dragOffsetRef.current.y));
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

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    resizeStartRef.current = {
      width: clampedWidth,
      height: clampedHeight,
      clientX: e.clientX,
      clientY: e.clientY,
    };
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      const { width, height, clientX, clientY } = resizeStartRef.current;
      const dx = ev.clientX - clientX;
      const dy = ev.clientY - clientY;
      const vp = getViewportSize();
      const newWidth = Math.max(320, Math.min(900, Math.min(vp.width - left - 16, width + dx)));
      const newHeight = Math.max(180, Math.min(500, Math.min(vp.height - top - 16, height + dy)));
      onOverlaySizeChange(newWidth, newHeight);
    };
    const onUp = () => {
      resizingRef.current = false;
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
      className="fixed z-[100015] overflow-hidden rounded-xl border border-white/30 bg-black/60 shadow-2xl backdrop-blur-sm"
      style={{ width: clampedWidth, maxWidth: "calc(100vw - 24px)", height: clampedHeight, left, top, opacity }}
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
      <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-12 -translate-y-1/2 border-y border-emerald-300/40 bg-emerald-200/10" />
      <div
        ref={viewportRef}
        className={`h-full overflow-hidden px-6 py-7 text-center text-white ${isScrollDragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ clipPath: "inset(32px 0 0 0)" }}
        onPointerDown={onScrollPointerDown}
        title="Drag to scroll"
      >
        <div
          ref={scrollContentRef}
          style={{ fontSize, lineHeight: 1.55, willChange: "transform" }}
        >
          <div style={{ paddingTop: "1em", paddingBottom: "80%", whiteSpace: "pre-wrap" }}>
            {script || "Paste your script in Teleprompter panel."}
          </div>
        </div>
      </div>
      <div
        role="button"
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        className={`absolute bottom-0 right-0 z-30 h-4 w-4 cursor-se-resize ${locked ? "pointer-events-none opacity-50" : "hover:bg-white/10"}`}
        style={{ background: "linear-gradient(135deg, transparent 45%, rgba(255,255,255,.4) 45%)" }}
        title="Drag to resize"
        aria-label="Resize overlay"
      />
    </div>
  );
}

export function TeleprompterPanel({
  isVisible,
  isPlaying,
  script,
  scripts,
  activeScriptId,
  onSwitchScript,
  onNewScript,
  onSaveAsScript,
  onRenameScript,
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
  onFlushSave,
  onEditorScroll,
}: TeleprompterPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [editingScriptName, setEditingScriptName] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const saveAsRef = useRef<HTMLDivElement>(null);
  const currentScript = scripts.find((s) => s.id === activeScriptId);

  const downloadScript = useCallback(
    (ext: "md" | "txt") => {
      const content = script;
      const name = (currentScript?.name ?? "script").replace(/[<>:"/\\|?*]/g, "_");
      const filename = `${name}.${ext}`;
      const mime = ext === "md" ? "text/markdown" : "text/plain";
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setSaveAsOpen(false);
    },
    [script, currentScript?.name]
  );

  useEffect(() => {
    if (!saveAsOpen) return;
    const close = (e: MouseEvent) => {
      if (saveAsRef.current && !saveAsRef.current.contains(e.target as Node)) setSaveAsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [saveAsOpen]);
  const idleTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollTopByScriptRef = useRef<Record<string, number>>({});
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

  // Restore textarea scroll position when panel expands (e.g. after returning from whiteboard)
  useEffect(() => {
    if (!collapsed && textareaRef.current) {
      const el = textareaRef.current;
      const saved = scrollTopByScriptRef.current[activeScriptId] ?? 0;
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll > 0) {
        requestAnimationFrame(() => {
          el.scrollTop = Math.min(saved, maxScroll);
        });
      }
    }
  }, [collapsed, activeScriptId]);

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
        className="fixed z-[100015] flex h-11 w-[260px] items-center justify-between rounded-xl border border-white/30 bg-black/75 px-2 text-xs text-white shadow-2xl backdrop-blur-md"
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
      className="fixed z-[100015] w-[360px] rounded-xl border border-white/30 bg-black/70 p-3 text-xs text-white shadow-2xl backdrop-blur-md"
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
      <div className="mb-2 flex items-center gap-1">
        {editingScriptName ? (
          <input
            type="text"
            defaultValue={currentScript?.name ?? "Untitled"}
            className="min-w-0 flex-1 rounded border border-white/20 bg-black/45 px-2 py-1 text-xs text-white outline-none"
            autoFocus
            onBlur={(e) => {
              const name = e.target.value.trim() || (currentScript?.name ?? "Untitled");
              onRenameScript(name);
              setEditingScriptName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const name = e.currentTarget.value.trim() || (currentScript?.name ?? "Untitled");
                onRenameScript(name);
                setEditingScriptName(false);
              }
              if (e.key === "Escape") setEditingScriptName(false);
            }}
          />
        ) : (
          <select
            value={activeScriptId}
            onChange={(e) => onSwitchScript(e.target.value)}
            className="flex-1 rounded border border-white/20 bg-black/45 px-2 py-1 text-xs text-white"
          >
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <GlassButton size="sm" variant="secondary" onClick={onNewScript} title="New script">
          New
        </GlassButton>
        <div ref={saveAsRef} className="relative">
          <GlassButton
            size="sm"
            variant="secondary"
            onClick={() => setSaveAsOpen((o) => !o)}
            title="Save as new script or export to file"
          >
            Save as
          </GlassButton>
          {saveAsOpen && (
            <div
              className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded border border-white/20 bg-black/90 py-1 shadow-xl"
              data-dreamwork-no-intercept
            >
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-white/15"
                onClick={() => {
                  setSaveAsOpen(false);
                  onSaveAsScript();
                }}
              >
                Save as new script
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-white/15"
                onClick={() => downloadScript("md")}
              >
                Download as .md
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-white/15"
                onClick={() => downloadScript("txt")}
              >
                Download as .txt
              </button>
            </div>
          )}
        </div>
        <GlassButton
          size="sm"
          variant="secondary"
          onClick={() => setEditingScriptName(true)}
          title="Rename script"
        >
          Rename
        </GlassButton>
      </div>
      <textarea
        ref={textareaRef}
        value={script}
        onChange={(e) => onSetScript(e.target.value)}
        onBlur={() => onFlushSave?.()}
        onFocus={() => {
          const el = textareaRef.current;
          const saved = scrollTopByScriptRef.current[activeScriptId];
          if (el && saved != null) {
            const maxScroll = el.scrollHeight - el.clientHeight;
            if (maxScroll > 0 && el.scrollTop !== saved) {
              el.scrollTop = Math.min(saved, maxScroll);
            }
          }
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          scrollTopByScriptRef.current[activeScriptId] = el.scrollTop;
          const max = el.scrollHeight - el.clientHeight;
          if (max > 0) {
            const ratio = el.scrollTop / max;
            onEditorScroll?.(ratio);
            onSetPlaying(false);
          }
        }}
        className="mb-3 h-36 w-full resize-y rounded-md border border-white/20 bg-black/45 p-2 text-xs text-white outline-none"
        placeholder="Paste script here..."
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <label className="col-span-2 flex flex-col gap-1">
          <span>Speed: {Math.round(speed)} px/s</span>
          <input type="range" min={10} max={80} step={2} value={speed} onChange={(e) => onSetSpeed(Number(e.target.value))} />
          <span className="text-[10px] text-white/55">
            Ref: 30–40 news | 40–50 interview | 50–60 casual
          </span>
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
      <p className="mt-2 text-[11px] text-white/70">Shortcuts: Space play/pause, Up/Down speed, R reset, H hide. Drag overlay to scroll. Scroll editor to sync overlay.</p>
    </div>
  );
}
