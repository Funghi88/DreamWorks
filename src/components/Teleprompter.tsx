import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState, memo } from "react";
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
  /** Editor panel dimensions (persisted). */
  panelWidth: number;
  panelHeight: number;
  onPanelSizeChange: (width: number, height: number) => void;
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
  /** Pass latest textarea text so disk save runs in the same tick as ⌘S (parent state may not have flushed yet). */
  onFlushSave?: (latestScriptContent?: string) => void;
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

export const TeleprompterOverlay = memo(function TeleprompterOverlay({
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
      className="!fixed z-[1000000] overflow-hidden rounded-xl border border-white/30 bg-black/60 shadow-2xl backdrop-blur-sm"
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
        className={`absolute bottom-0 right-0 z-30 h-[18px] w-[18px] cursor-se-resize rounded-br-xl ${locked ? "pointer-events-none opacity-40" : "hover:bg-white/[0.06]"}`}
        style={{
          background:
            "linear-gradient(to top left, rgba(255,255,255,.28) 0%, rgba(255,255,255,.28) 42%, transparent 42.5%)",
        }}
        title="Drag to resize"
        aria-label="Resize overlay"
      />
    </div>
  );
});

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
  panelWidth,
  panelHeight,
  onPanelSizeChange,
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
  const MIN_PANEL_HEIGHT = 320;
  const MIN_EDITOR_HEIGHT = 96;
  const PANEL_CHROME_RESERVED = 190;
  const [collapsed, setCollapsed] = useState(false);
  const [editingScriptName, setEditingScriptName] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const saveAsRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollTopByScriptRef = useRef<Record<string, number>>({});
  const scriptPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScript = scripts.find((s) => s.id === activeScriptId);
  /** Local draft: avoid lifting every keystroke to App (heavy re-renders + settings effect). */
  const [draftScript, setDraftScript] = useState(script);

  useEffect(() => {
    setDraftScript(script);
  }, [activeScriptId]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && document.activeElement === ta) return;
    setDraftScript(script);
  }, [script]);

  useEffect(() => {
    return () => {
      if (scriptPushTimerRef.current != null) clearTimeout(scriptPushTimerRef.current);
    };
  }, []);

  const downloadScript = useCallback(
    (ext: "md" | "txt") => {
      const content = draftScript;
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
    [draftScript, currentScript?.name]
  );

  const flushDraftToParent = useCallback(() => {
    if (scriptPushTimerRef.current != null) {
      clearTimeout(scriptPushTimerRef.current);
      scriptPushTimerRef.current = null;
    }
    onSetScript(draftScript);
  }, [draftScript, onSetScript]);

  useEffect(() => {
    if (!saveAsOpen) return;
    const close = (e: MouseEvent) => {
      if (saveAsRef.current && !saveAsRef.current.contains(e.target as Node)) setSaveAsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [saveAsOpen]);
  const autoMinimizeTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const lastPointerDuringDragRef = useRef({ x: 0, y: 0 });
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const panelLivePosRef = useRef<{ x: number; y: number } | null>(null);
  const [panelLivePos, setPanelLivePos] = useState<{ x: number; y: number } | null>(null);
  const [panelSize, setPanelSize] = useState({ w: panelWidth, h: panelHeight });
  const [editorHeight, setEditorHeight] = useState(() => Math.max(140, panelHeight - PANEL_CHROME_RESERVED));
  const panelSizeRef = useRef(panelSize);
  panelSizeRef.current = panelSize;
  const editorHeightRef = useRef(editorHeight);
  editorHeightRef.current = editorHeight;
  const panelResizingRef = useRef(false);
  const editorResizingRef = useRef(false);

  useEffect(() => {
    setPanelSize({ w: panelWidth, h: panelHeight });
  }, [panelWidth, panelHeight]);

  useEffect(() => {
    const maxEditorHeight = Math.max(MIN_EDITOR_HEIGHT, panelSize.h - PANEL_CHROME_RESERVED);
    if (editorHeightRef.current > maxEditorHeight) {
      setEditorHeight(maxEditorHeight);
      return;
    }
    if (editorHeightRef.current < MIN_EDITOR_HEIGHT) {
      setEditorHeight(MIN_EDITOR_HEIGHT);
    }
  }, [panelSize.h]);

  const expandedWidth = panelSize.w;
  const expandedHeight = panelSize.h;
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

  const AUTO_MINIMIZE_MS = 3000;

  const clearAutoMinimizeTimer = useCallback(() => {
    if (autoMinimizeTimerRef.current != null) {
      window.clearTimeout(autoMinimizeTimerRef.current);
      autoMinimizeTimerRef.current = null;
    }
  }, []);

  /** 鼠标离开「提词器控制面板」整块区域一段时间后收起（鼠标在编辑器/按钮/下拉等任一子区域内均视为仍在面板内）。 */
  const scheduleAutoMinimize = useCallback(() => {
    if (collapsed || draggingRef.current) return;
    clearAutoMinimizeTimer();
    autoMinimizeTimerRef.current = window.setTimeout(() => setCollapsed(true), AUTO_MINIMIZE_MS);
  }, [collapsed, clearAutoMinimizeTimer]);

  useEffect(() => {
    if (!isVisible) return;
    setCollapsed(false);
    clearAutoMinimizeTimer();
    return clearAutoMinimizeTimer;
  }, [isVisible, clearAutoMinimizeTimer]);

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
    if (!collapsed) clearAutoMinimizeTimer();
    lastPointerDuringDragRef.current = { x: e.clientX, y: e.clientY };
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
      lastPointerDuringDragRef.current = { x: ev.clientX, y: ev.clientY };
      const width = collapsed ? collapsedWidth : panelSizeRef.current.w;
      const height = collapsed ? collapsedHeight : panelSizeRef.current.h;
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
      const el = panelRef.current;
      if (el && !collapsed) {
        const { x, y } = lastPointerDuringDragRef.current;
        const r = el.getBoundingClientRect();
        const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        if (!inside) scheduleAutoMinimize();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onPanelResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    clearAutoMinimizeTimer();
    const anchor = panelLivePosRef.current ?? position ?? { x: left, y: top };
    panelLivePosRef.current = anchor;
    setPanelLivePos(anchor);
    panelResizingRef.current = true;
    const startW = panelSizeRef.current.w;
    const startH = panelSizeRef.current.h;
    const sx = e.clientX;
    const sy = e.clientY;
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);
    let lastW = startW;
    let lastH = startH;
    const onMove = (ev: PointerEvent) => {
      if (!panelResizingRef.current) return;
      const vp = getViewportSize();
      const maxW = Math.min(920, vp.width - 16);
      const maxH = Math.min(900, vp.height - 16);
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      lastW = Math.max(280, Math.min(maxW, startW + dx));
      lastH = Math.max(MIN_PANEL_HEIGHT, Math.min(maxH, startH + dy));
      setPanelSize({ w: lastW, h: lastH });
    };
    const onUp = () => {
      panelResizingRef.current = false;
      onPanelSizeChange(lastW, lastH);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onEditorResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    clearAutoMinimizeTimer();
    const anchor = panelLivePosRef.current ?? position ?? { x: left, y: top };
    panelLivePosRef.current = anchor;
    setPanelLivePos(anchor);
    editorResizingRef.current = true;
    const startPanelH = panelSizeRef.current.h;
    const startEditorH = editorHeightRef.current;
    const sy = e.clientY;
    let lastPanelH = startPanelH;
    let lastEditorH = startEditorH;
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!editorResizingRef.current) return;
      const vp = getViewportSize();
      const maxPanelByViewport = Math.min(900, Math.max(MIN_PANEL_HEIGHT, vp.height - top - 8));
      const dy = ev.clientY - sy;
      const nextPanelH = Math.max(MIN_PANEL_HEIGHT, Math.min(maxPanelByViewport, startPanelH + dy));
      const panelDelta = nextPanelH - startPanelH;
      const nextEditorMax = Math.max(MIN_EDITOR_HEIGHT, nextPanelH - PANEL_CHROME_RESERVED);
      const nextEditorH = Math.max(MIN_EDITOR_HEIGHT, Math.min(nextEditorMax, startEditorH + panelDelta));
      lastPanelH = nextPanelH;
      lastEditorH = nextEditorH;
      setPanelSize((prev) => ({ ...prev, h: nextPanelH }));
      setEditorHeight(nextEditorH);
    };

    const onUp = () => {
      editorResizingRef.current = false;
      setEditorHeight(lastEditorH);
      onPanelSizeChange(panelSizeRef.current.w, lastPanelH);
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
        className="!fixed z-[1000000] flex h-11 w-[260px] items-center justify-between rounded-xl border border-white/30 bg-black/75 px-2 text-xs text-white shadow-2xl backdrop-blur-md"
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
              clearAutoMinimizeTimer();
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px]"
            onClick={() => {
              flushDraftToParent();
              onHide();
            }}
          >
            Hide
          </button>
        </div>
      </div>
    );
  }

  /** Same height / radius / horizontal padding as GlassButton `sm` overrides (h-7, rounded-lg, px-2). */
  const tpActionClass =
    "!h-7 min-h-0 shrink-0 !px-2 !py-0 !text-[10px] font-normal leading-tight";
  const tpSelectClass =
    "box-border h-7 min-w-0 flex-1 rounded-lg border border-white/20 bg-black/45 px-2 py-0 text-[10px] font-normal leading-7 text-white outline-none";

  return (
    <div
      ref={panelRef}
      data-dreamwork-no-intercept
      className="!fixed z-[1000000] box-border flex max-h-[calc(100vh-16px)] min-h-0 flex-col overflow-hidden rounded-xl border border-white/30 bg-black/70 p-2.5 text-[11px] text-white shadow-2xl backdrop-blur-md"
      style={{
        left,
        top,
        width: panelSize.w,
        height: panelSize.h,
        maxWidth: "min(920px, calc(100vw - 16px))",
      }}
      onMouseEnter={clearAutoMinimizeTimer}
      onMouseLeave={scheduleAutoMinimize}
    >
      {/* Fixed chrome — never overlaps; body uses flex-1 + min-h-0 like Figma auto-layout */}
      <div className="mb-1.5 flex shrink-0 items-center gap-2">
        <div
          className={`h-6 w-7 shrink-0 rounded border border-white/25 bg-black/45 text-center text-[10px] leading-6 ${locked ? "cursor-not-allowed" : "cursor-grab"}`}
          onPointerDown={onPanelDragDown}
          title={locked ? "Position locked" : "Drag panel"}
        >
          ::
        </div>
        <span className="mr-auto text-[12px] font-semibold">Teleprompter</span>
        <button
          type="button"
          onClick={onToggleLocked}
          className="shrink-0 rounded border border-white/30 bg-black/45 px-1.5 py-0.5 text-[10px]"
          title={locked ? "Unlock teleprompter drag" : "Lock teleprompter position"}
        >
          {locked ? "Locked" : "Lock"}
        </button>
      </div>
      <div className="mb-1.5 flex w-full min-w-0 shrink-0 flex-wrap gap-1">
        <GlassButton
          size="sm"
          className={tpActionClass}
          variant={isPlaying ? "primary" : "secondary"}
          onClick={() => onSetPlaying(!isPlaying)}
        >
          {isPlaying ? "Pause" : "Play"}
        </GlassButton>
        <GlassButton size="sm" className={tpActionClass} variant="secondary" onClick={onReset}>
          Reset
        </GlassButton>
        <GlassButton size="sm" className={tpActionClass} variant="secondary" onClick={() => setCollapsed(true)}>
          Min
        </GlassButton>
        <GlassButton
          size="sm"
          className={tpActionClass}
          variant="ghost"
          onClick={() => {
            flushDraftToParent();
            onHide();
          }}
        >
          Hide
        </GlassButton>
      </div>
      <div className="mb-2 flex w-full min-w-0 shrink-0 flex-wrap items-center gap-1">
        {editingScriptName ? (
          <input
            type="text"
            defaultValue={currentScript?.name ?? "Untitled"}
            className={tpSelectClass}
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
            onChange={(e) => {
              flushDraftToParent();
              onSwitchScript(e.target.value);
            }}
            className={tpSelectClass}
          >
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <GlassButton
          size="sm"
          className={tpActionClass}
          variant="secondary"
          onClick={() => {
            flushDraftToParent();
            onNewScript();
          }}
          title="New script"
        >
          New
        </GlassButton>
        <div ref={saveAsRef} className="relative shrink-0">
          <GlassButton
            size="sm"
            className={`${tpActionClass} whitespace-nowrap`}
            variant="secondary"
            onClick={() => setSaveAsOpen((o) => !o)}
            title="Save as new script or export to file"
          >
            Save as
          </GlassButton>
          {saveAsOpen && (
            <div
              className="absolute left-0 top-full z-50 mt-1 min-w-[148px] rounded border border-white/20 bg-black/90 py-0.5 shadow-xl"
              data-dreamwork-no-intercept
            >
              <button
                type="button"
                className="block w-full px-2.5 py-1 text-left text-[10px] hover:bg-white/15"
                onClick={() => {
                  setSaveAsOpen(false);
                  flushDraftToParent();
                  onSaveAsScript();
                }}
              >
                Save as new script
              </button>
              <button
                type="button"
                className="block w-full px-2.5 py-1 text-left text-[10px] hover:bg-white/15"
                onClick={() => downloadScript("md")}
              >
                Download as .md
              </button>
              <button
                type="button"
                className="block w-full px-2.5 py-1 text-left text-[10px] hover:bg-white/15"
                onClick={() => downloadScript("txt")}
              >
                Download as .txt
              </button>
            </div>
          )}
        </div>
        <GlassButton
          size="sm"
          className={`${tpActionClass} whitespace-nowrap`}
          variant="secondary"
          onClick={() => setEditingScriptName(true)}
          title="Rename script"
        >
          Rename
        </GlassButton>
      </div>

      {/* Scroll body: stack is non-overlapping; short panels scroll as one column (auto-layout safe) */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <textarea
          ref={textareaRef}
          value={draftScript}
          onChange={(e) => {
            const v = e.target.value;
            setDraftScript(v);
            if (scriptPushTimerRef.current != null) clearTimeout(scriptPushTimerRef.current);
            scriptPushTimerRef.current = setTimeout(() => {
              scriptPushTimerRef.current = null;
              onSetScript(v);
            }, 120);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              if (scriptPushTimerRef.current != null) {
                clearTimeout(scriptPushTimerRef.current);
                scriptPushTimerRef.current = null;
              }
              const v = textareaRef.current?.value ?? draftScript;
              setDraftScript(v);
              onSetScript(v);
              onFlushSave?.(v);
            }
          }}
          onBlur={(e) => {
            if (scriptPushTimerRef.current != null) {
              clearTimeout(scriptPushTimerRef.current);
              scriptPushTimerRef.current = null;
            }
            const v = e.target.value;
            setDraftScript(v);
            onSetScript(v);
            onFlushSave?.(v);
          }}
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
          rows={6}
          style={{ height: editorHeight }}
          className="w-full min-w-0 shrink-0 resize-none overflow-y-auto rounded-md border border-white/20 bg-black/45 p-2 text-[11px] leading-relaxed text-white outline-none"
          placeholder="Paste script here..."
        />
        <div
          role="separator"
          aria-orientation="horizontal"
          className={`mt-1.5 h-2 shrink-0 rounded border border-white/15 bg-black/35 ${locked ? "cursor-not-allowed opacity-40" : "cursor-ns-resize hover:bg-white/10"}`}
          onPointerDown={onEditorResizePointerDown}
          title={locked ? "Unlock to resize editor" : "Drag down to enlarge editor panel"}
        />

        <div className="mt-2 flex shrink-0 flex-col gap-2 border-t border-white/15 pt-2">
          <div className="grid grid-cols-2 gap-x-2 gap-y-2 text-[10px]">
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-white/90">Speed: {Math.round(speed)} px/s</span>
              <input
                type="range"
                min={10}
                max={80}
                step={2}
                value={speed}
                className="w-full"
                onChange={(e) => onSetSpeed(Number(e.target.value))}
              />
              <span className="text-[10px] leading-tight text-white/55">
                Ref: 30–40 news | 40–50 interview | 50–60 casual
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-white/90">Font: {Math.round(fontSize)} px</span>
              <input
                type="range"
                min={18}
                max={52}
                step={1}
                value={fontSize}
                className="w-full"
                onChange={(e) => onSetFontSize(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-white/90">Opacity: {opacity.toFixed(2)}</span>
              <input
                type="range"
                min={0.35}
                max={1}
                step={0.01}
                value={opacity}
                className="w-full"
                onChange={(e) => onSetOpacity(Number(e.target.value))}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-white/90">Width: {Math.round(overlayWidth)} px</span>
              <input
                type="range"
                min={320}
                max={900}
                step={10}
                value={overlayWidth}
                className="w-full"
                onChange={(e) => onSetOverlayWidth(Number(e.target.value))}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[10px] text-white/90">
            <input type="checkbox" checked={nearCamera} onChange={(e) => onSetNearCamera(e.target.checked)} />
            <span>Near camera</span>
          </label>
          <p className="text-[10px] leading-snug text-white/60">
            Shortcuts: Space play/pause, Up/Down speed, R reset, H hide. Drag overlay to scroll. Scroll editor to sync overlay. Drag corner to resize panel.
          </p>
        </div>
      </div>
      <div
        role="button"
        tabIndex={0}
        onPointerDown={onPanelResizePointerDown}
        className={`absolute bottom-0 right-0 z-30 h-[14px] w-[14px] cursor-se-resize rounded-br-xl ${locked ? "pointer-events-none opacity-35" : "hover:bg-white/[0.06]"}`}
        style={{
          background:
            "linear-gradient(to top left, rgba(255,255,255,.22) 0%, rgba(255,255,255,.22) 42%, transparent 42.5%)",
        }}
        title={locked ? "Unlock to resize" : "Drag to resize panel"}
        aria-label="Resize panel"
      />
    </div>
  );
}
