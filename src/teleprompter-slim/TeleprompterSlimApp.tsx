import { useCallback, useEffect, useMemo, useState } from "react";
import { TeleprompterOverlay } from "@/components/Teleprompter";
import type { TeleprompterVoskLang } from "@/hooks/useVoskTeleprompterFollow";

const CHANNEL = "dreamwork-teleprompter";

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
};

function publishControl(payload: Record<string, unknown>) {
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage({ type: "teleprompter-control", ...payload });
  ch.close();
}

/** Dedicated always-on-top BrowserWindow — Slim only; state synced with main via BroadcastChannel. */
export function TeleprompterSlimApp() {
  const [s, setS] = useState<SyncState>(defaultState);

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
      }));
    };
    channel.addEventListener("message", onMessage);
    channel.postMessage({ type: "teleprompter-request-state" });
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => {
      publishControl({ slimMode: false });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

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
    publishControl({ slimMode });
    if (!slimMode && window.close) window.close();
  }, []);

  const displayScript = useMemo(() => s.script, [s.script]);

  return (
    <div className="h-auto min-h-0 w-full bg-transparent text-white">
      <TeleprompterOverlay
          isVisible
          slimMode
          embeddedInSlimBrowserWindow
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
          onHide={() => onSetSlimMode(false)}
          onNudgeSpeed={(delta) => {
            const next = Math.max(10, Math.min(80, s.speed + delta));
            setS((prev) => ({ ...prev, speed: next }));
            publishControl({ speed: next });
          }}
          voskLang={s.voskLang}
          followScriptIdentity={s.activeScriptId || "__slim__"}
          muteVoskForDetachedHelper={false}
          onSetVoskLang={onSetVoskLang}
        />
    </div>
  );
}
