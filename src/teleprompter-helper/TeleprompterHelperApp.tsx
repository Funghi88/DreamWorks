import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeleprompterOverlay } from "@/components/Teleprompter";
import type { TeleprompterVoskLang } from "@/hooks/useVoskTeleprompterFollow";

const CHANNEL = "dreamwork-teleprompter";
const HELPER_WINDOW_LABEL = "teleprompter-helper";

type HelperBoundsApi = {
  getHelperWindowBounds?: (label: string) => Promise<{ x: number; y: number; width: number; height: number } | null>;
  setHelperWindowBounds?: (
    label: string,
    bounds: { x?: number; y?: number; width: number; height: number },
  ) => Promise<boolean>;
};

type SyncState = {
  script: string;
  playing: boolean;
  speed: number;
  fontSize: number;
  opacity: number;
  width: number;
  height: number;
  locked: boolean;
  resetSeq: number;
  followMode: boolean;
  voskLang: TeleprompterVoskLang;
  activeScriptId: string;
  slimMode: boolean;
};

const defaultState: SyncState = {
  script: "",
  playing: false,
  speed: 30,
  fontSize: 32,
  opacity: 0.68,
  width: 560,
  height: 280,
  locked: false,
  resetSeq: 0,
  followMode: false,
  voskLang: "en",
  activeScriptId: "",
  slimMode: false,
};

function publishControl(payload: Record<string, unknown>) {
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage({ type: "teleprompter-control", ...payload });
  ch.close();
}

export function TeleprompterHelperApp() {
  const [s, setS] = useState<SyncState>(defaultState);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "teleprompter-state") return;
      setS((prev) => ({
        script: typeof data.script === "string" ? data.script : prev.script,
        playing: typeof data.playing === "boolean" ? data.playing : prev.playing,
        speed: typeof data.speed === "number" ? data.speed : prev.speed,
        fontSize: typeof data.fontSize === "number" ? data.fontSize : prev.fontSize,
        opacity: typeof data.opacity === "number" ? data.opacity : prev.opacity,
        width: typeof data.width === "number" ? data.width : prev.width,
        height: typeof data.height === "number" ? data.height : prev.height,
        locked: typeof data.locked === "boolean" ? data.locked : prev.locked,
        resetSeq: typeof data.resetSeq === "number" ? data.resetSeq : prev.resetSeq,
        followMode: typeof data.followMode === "boolean" ? data.followMode : prev.followMode,
        voskLang:
          data.voskLang === "en" || data.voskLang === "zh" || data.voskLang === "it"
            ? data.voskLang
            : prev.voskLang,
        activeScriptId: typeof data.activeScriptId === "string" ? data.activeScriptId : prev.activeScriptId,
        slimMode: typeof data.slimMode === "boolean" ? data.slimMode : prev.slimMode,
      }));
    };
    channel.addEventListener("message", onMessage);
    channel.postMessage({ type: "teleprompter-request-state" });
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, []);

  /** Measure the padded content area so overlay logical size matches the window. */
  useEffect(() => {
    if (s.slimMode) return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr || cr.width < 64 || cr.height < 64) return;
      const w = Math.round(cr.width);
      const h = Math.round(cr.height);
      setS((prev) => {
        if (prev.width === w && prev.height === h) return prev;
        return { ...prev, width: w, height: h };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.slimMode]);

  useEffect(() => {
    if (s.slimMode) return;
    publishControl({ width: s.width, height: s.height });
  }, [s.width, s.height, s.slimMode]);

  const onHelperOuterResizePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const api = (window as unknown as { electronAPI?: HelperBoundsApi }).electronAPI;
    if (!api?.getHelperWindowBounds || !api?.setHelperWindowBounds) return;
    void (async () => {
      const start = await api.getHelperWindowBounds!(HELPER_WINDOW_LABEL);
      if (!start) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const t = e.currentTarget;
      if (t.setPointerCapture) t.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        void api.setHelperWindowBounds!(HELPER_WINDOW_LABEL, {
          x: start.x,
          y: start.y,
          width: start.width + dx,
          height: start.height + dy,
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          t.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    })();
  }, []);

  const helperResizeApi = typeof window !== "undefined" ? (window as unknown as { electronAPI?: HelperBoundsApi }).electronAPI : undefined;
  const canResizeHelperWindow = !!(helperResizeApi?.getHelperWindowBounds && helperResizeApi?.setHelperWindowBounds);

  const onSetPlaying = useCallback((playing: boolean) => {
    setS((prev) => ({ ...prev, playing }));
    publishControl({ playing });
  }, []);

  const onSetFollowMode = useCallback((followMode: boolean) => {
    setS((prev) => ({ ...prev, followMode }));
    publishControl({ followMode });
  }, []);

  const onSetVoskLang = useCallback((voskLang: TeleprompterVoskLang) => {
    setS((prev) => ({ ...prev, voskLang }));
    publishControl({ voskLang });
  }, []);

  const onOverlaySizeChange = useCallback((width: number, height: number) => {
    setS((prev) => ({ ...prev, width, height }));
    publishControl({ width, height });
  }, []);

  const onToggleLocked = useCallback(() => {
    setS((prev) => {
      const locked = !prev.locked;
      publishControl({ locked });
      return { ...prev, locked };
    });
  }, []);

  const onReset = useCallback(() => {
    setS((prev) => {
      const resetSeq = prev.resetSeq + 1;
      publishControl({ resetSeq, playing: false });
      return { ...prev, resetSeq, playing: false };
    });
  }, []);

  const onSetSlimMode = useCallback((slimMode: boolean) => {
    setS((prev) => ({ ...prev, slimMode }));
    publishControl({ slimMode });
  }, []);

  const onHide = useCallback(() => {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ type: "teleprompter-close" });
    ch.close();
    if (window.close) window.close();
  }, []);

  const displayScript = useMemo(() => s.script, [s.script]);

  return (
    <div
      className={`relative flex h-full min-h-0 w-full flex-col rounded-[14px] bg-transparent text-white ${s.slimMode ? "overflow-visible" : "overflow-hidden"}`}
    >
      {!s.slimMode && (
        <div
          className="relative flex h-7 shrink-0 cursor-move items-center rounded-t-[14px] border border-white/45 bg-white/25 shadow-sm backdrop-blur-md text-[12px] font-bold text-black/78"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
          title="Drag window"
        >
          <span className="pointer-events-none absolute left-1/2 top-1/2 z-0 -translate-x-1/2 -translate-y-1/2">
            Teleprompter
          </span>
          <button
            type="button"
            className="relative z-10 ml-auto mr-2 rounded px-2 py-0.5 text-[11px] font-medium text-black/80"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            onClick={onHide}
          >
            Close
          </button>
        </div>
      )}
      <div
        ref={contentRef}
        className={`flex min-h-0 w-full min-w-0 flex-1 flex-col items-stretch justify-stretch ${
          s.slimMode
            ? "overflow-visible p-0"
            : "overflow-hidden rounded-b-[14px] border-x border-b border-white/45 bg-white/25 p-2 backdrop-blur-md"
        }`}
      >
        <TeleprompterOverlay
          isVisible={!s.slimMode}
          slimMode={s.slimMode}
          onSetSlimMode={onSetSlimMode}
          script={displayScript}
          isPlaying={s.playing}
          speed={s.speed}
          fontSize={s.fontSize}
          opacity={s.opacity}
          overlayWidth={s.width}
          overlayHeight={s.height}
          nearCamera={false}
          anchorRect={null}
          dockColumnRect={null}
          position={{ x: 0, y: 0 }}
          locked={s.locked}
          resetSignal={s.resetSeq}
          editorScrollRatio={null}
          followMode={s.followMode}
          onSetFollowMode={onSetFollowMode}
          onSetPlaying={onSetPlaying}
          onPositionChange={() => {}}
          onOverlaySizeChange={onOverlaySizeChange}
          onDragStart={() => {}}
          onToggleLocked={onToggleLocked}
          onReset={onReset}
          onHide={onHide}
          onNudgeSpeed={(delta) => {
            const next = Math.max(10, Math.min(80, s.speed + delta));
            setS((prev) => ({ ...prev, speed: next }));
            publishControl({ speed: next });
          }}
          voskLang={s.voskLang}
          followScriptIdentity={s.activeScriptId || "__helper__"}
          muteVoskForDetachedHelper={s.slimMode}
          embeddedInDetachedHelperWindow
          onSetVoskLang={onSetVoskLang}
        />
      </div>
      {!s.slimMode && canResizeHelperWindow && (
        <div
          role="presentation"
          className="fixed bottom-0 right-0 z-[2147483000] h-[20px] w-[20px] cursor-se-resize rounded-br-[12px]"
          style={
            {
              WebkitAppRegion: "no-drag",
              background:
                "linear-gradient(to top left, rgba(0,0,0,.12) 0%, rgba(0,0,0,.12) 38%, rgba(255,255,255,.35) 38.5%, rgba(255,255,255,.35) 55%, transparent 55.5%)",
            } as CSSProperties
          }
          onPointerDown={onHelperOuterResizePointerDown}
          title="Drag to resize window"
        />
      )}
    </div>
  );
}
