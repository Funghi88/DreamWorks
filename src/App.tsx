import { Component, useRef, useState, useEffect, useLayoutEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@/components/Glass";
import { RecordingControls } from "@/components/RecordingControls";
import { TeleprompterOverlay, TeleprompterPanel } from "@/components/Teleprompter";
import { useWindowSize } from "@/hooks/useWindowSize";
import { Sidebar } from "@/components/Sidebar";
import { CircularWebcam } from "@/components/CircularWebcam";
import { ExcalidrawBoard } from "@/components/ExcalidrawBoard";
import type { AvatarDecor, AvatarShape } from "@/components/SettingsPanel";
import { beautySettingsToFilter, presets } from "@/lib/beautyEffects";
import { loadSettings, loadSettingsAsync, saveSettings, type RecordResolution, type LetterboxBackground } from "@/lib/storage";
import {
  initFaceLandmarker,
  nextVideoTimestamp,
  drawFaceFilter,
  type FaceFilterType,
} from "@/lib/faceFilters";
import { createCircularIcon } from "@/lib/circularIcon";
import { Settings } from "lucide-react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { setCompactMode, setNormalMode } from "@/lib/windowUtils";
import { lazy, Suspense } from "react";

const LiveMeetingModal = lazy(() =>
  import("@/components/LiveMeeting/LiveMeetingModal").then((m) => ({ default: m.LiveMeetingModal }))
);

const RECORD_RESOLUTIONS: Record<RecordResolution, { w: number; h: number }> = {
  "1080p": { w: 1920, h: 1080 },
  "2K": { w: 2560, h: 1440 },
  "4K": { w: 3840, h: 2160 },
};

const RECORD_BITRATES: Record<RecordResolution, number> = {
  "1080p": 10_000_000,
  "2K": 18_000_000,
  "4K": 28_000_000,
};
const TELEPROMPTER_HELPER_URL = "/teleprompter-helper.html";
const MONITOR_HELPER_URL = "/recording-monitor.html";
const TELEPROMPTER_CHANNEL = "dreamwork-teleprompter";
/** Offset between composite (recorded) and portal (draggable) camera in Capture Screen mode */
const CAMERA_OFFSET = 36;
import { ResizeHandle } from "@/components/ResizeHandle";

function drawLetterboxBg(
  ctx: CanvasRenderingContext2D,
  bg: LetterboxBackground,
  w: number,
  h: number,
  customImg: HTMLImageElement | null
) {
  if (bg === "custom" && customImg?.complete) {
    const scale = Math.max(w / customImg.naturalWidth, h / customImg.naturalHeight);
    const iw = customImg.naturalWidth * scale;
    const ih = customImg.naturalHeight * scale;
    ctx.drawImage(customImg, (w - iw) / 2, (h - ih) / 2, iw, ih);
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
  }
}


function formatRecordingTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.arcTo(x + w, y, x + w, y + rad, rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  ctx.lineTo(x + rad, y + h);
  ctx.arcTo(x, y + h, x, y + h - rad, rad);
  ctx.lineTo(x, y + rad);
  ctx.arcTo(x, y, x + rad, y, rad);
}

async function detectBlobFormat(blob: Blob): Promise<"webm" | "mp4"> {
  const t = blob.type.toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4")) return "mp4";
  const buf = await blob.slice(0, 12).arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return "webm";
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return "mp4";
  return "webm";
}

function ClipPreview({
  blob,
  onSave,
  onCopy,
}: {
  blob: Blob;
  onSave: (blobToSave: Blob, ext: string) => void;
  onCopy: () => void;
}) {
  const [url, setUrl] = useState("");
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  const handleSave = async (format: "webm" | "mp4") => {
    setConvertError(null);
    const detected = await detectBlobFormat(blob);
    if (format === "mp4" && detected === "mp4") {
      onSave(blob, "mp4");
      return;
    }
    if (format === "webm" && detected === "webm") {
      onSave(blob, "webm");
      return;
    }
    setConverting(true);
    try {
      const { webmToMp4, mp4ToWebm } = await import("@/lib/convertToMp4");
      const converted = format === "mp4" ? await webmToMp4(blob) : await mp4ToWebm(blob);
      if (converted) {
        onSave(converted, format);
      } else {
        setConvertError(`Conversion to ${format.toUpperCase()} failed`);
      }
    } finally {
      setConverting(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="aspect-video min-w-0 overflow-hidden rounded-xl border">
        <video
          src={url}
          controls
          className="aspect-video h-full w-full object-contain"
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="glass-panel rounded-lg border-white/20 bg-white/20 px-4 py-2 text-sm font-medium backdrop-blur-md hover:bg-white/30"
          onClick={() => handleSave("webm")}
          disabled={converting}
        >
          Save WebM
        </button>
        <button
          type="button"
          className="glass-panel rounded-lg border-white/20 bg-white/20 px-4 py-2 text-sm font-medium backdrop-blur-md hover:bg-white/30"
          onClick={() => handleSave("mp4")}
          disabled={converting}
        >
          {converting ? "Converting…" : "Save MP4"}
        </button>
        <button
          type="button"
          className="glass-panel rounded-lg border-white/20 bg-white/10 px-4 py-2 text-sm font-medium backdrop-blur-md hover:bg-white/20"
          onClick={onCopy}
          disabled={converting}
        >
          Copy
        </button>
      </div>
      {convertError && (
        <span className="text-xs text-red-400">{convertError}</span>
      )}
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

class TeleprompterErrorBoundary extends Component<
  { onCrash: () => void; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[Teleprompter] crashed, disabling overlay:", error);
    this.props.onCrash();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

class LiveMeetingErrorBoundary extends Component<
  { onClose: () => void; children: ReactNode },
  { hasError: boolean; error?: Error }
> {
  state = { hasError: false, error: undefined as Error | undefined };

  static getDerivedStateFromError(err: unknown) {
    return { hasError: true, error: err instanceof Error ? err : new Error(String(err)) };
  }

  componentDidCatch(error: unknown) {
    console.error("[LiveMeeting] crashed:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && this.props.onClose()}
        >
          <div className="glass-panel max-w-md rounded-xl p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold">Live Meeting unavailable</h3>
            <p className="mb-4 text-sm text-slate-600">
              Something went wrong. Please try again or check your camera/microphone permissions.
            </p>
            <button
              type="button"
              className="rounded-lg bg-white/20 px-4 py-2 text-sm font-medium hover:bg-white/30"
              onClick={this.props.onClose}
            >
              Close
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const persistentScreenVideoRef = useRef<HTMLVideoElement>(null);
  const cameraSourceVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const compositeRef = useRef<HTMLCanvasElement>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const portalCameraInnerRef = useRef<HTMLDivElement>(null);
  const avatarImgRef = useRef<HTMLImageElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fullPageContentRef = useRef<HTMLDivElement>(null);
  const whiteboardCanvasLayersRef = useRef<HTMLCanvasElement[]>([]);
  const lastCameraFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [portalRect, setPortalRect] = useState<DOMRect | null>(null);
  const [mainLayoutPortalRect, setMainLayoutPortalRect] = useState<DOMRect | null>(null);

  const [previewScreenStream, setPreviewScreenStream] = useState<MediaStream | null>(null);
  const [whiteboardScreenStream, setWhiteboardScreenStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [showPip, setShowPip] = useState(false);
  const [avatarImageSrc, setAvatarImageSrc] = useState<string | null>(
    () => loadSettings().avatarImageSrc ?? null
  );
  const [avatarSize, setAvatarSize] = useState(() => loadSettings().avatarSize ?? 120);
  const [avatarShape, setAvatarShape] = useState<AvatarShape>(
    () => loadSettings().avatarShape ?? "circle"
  );
  const [avatarDecor, setAvatarDecor] = useState<AvatarDecor>(
    () => loadSettings().avatarDecor ?? "none"
  );
  const [glowColor, setGlowColor] = useState(() => loadSettings().glowColor ?? "#64c8ff");
  const [beautyMode, setBeautyMode] = useState(() => loadSettings().beautyMode ?? false);
  const [beautySettings, setBeautySettings] = useState(() => {
    const s = loadSettings().beautySettings;
    if (s) return s;
    return presets.natural;
  });
  const [faceFilter, setFaceFilter] = useState<FaceFilterType>(
    () => loadSettings().faceFilter ?? "none"
  );
  const faceLandmarksRef = useRef<import("@mediapipe/tasks-vision").NormalizedLandmark[] | null>(null);
  const [pipPos, setPipPos] = useState(() => {
    const s = loadSettings().pipPos;
    return s ?? { x: 8, y: 8 };
  });
  const [fullPagePipPos, setFullPagePipPos] = useState(() => {
    const s = loadSettings().fullPagePipPos;
    return s ?? { x: 8, y: 8 };
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSettings().sidebarWidth ?? 320);
  const [previewWidth, setPreviewWidth] = useState(() => loadSettings().previewWidth ?? 200);
  const [outputHeight, setOutputHeight] = useState(240);
  const [whiteboardHeight, setWhiteboardHeight] = useState(
    () => loadSettings().whiteboardHeight ?? 220
  );
  const [pipDragging, setPipDragging] = useState(false);
  const pipDraggingRef = useRef(false);
  const pipOffsetRef = useRef({ x: 0, y: 0 });
  const [previewBoxDragging, setPreviewBoxDragging] = useState(false);
  const previewBoxDraggingRef = useRef(false);
  const previewBoxOffsetRef = useRef({ x: 0, y: 0 });
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [showWhiteboard, setShowWhiteboard] = useState(false);
  const [whiteboardInPreview, setWhiteboardInPreview] = useState(false);
  const [showUseInPreviewDialog, setShowUseInPreviewDialog] = useState(false);
  const fullPageWhiteboard = true;
  const activeScreenStream = whiteboardScreenStream ?? previewScreenStream;
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedClips, setRecordedClips] = useState<{ id: number; blob: Blob }[]>([]);
  const clipIdRef = useRef(0);
  const recordingTimeElapsedRef = useRef(0);
  const { width } = useWindowSize();
  const isCompact = width < 520;
  const isElectron =
    typeof window !== "undefined" &&
    !!(window as unknown as { electronAPI?: unknown }).electronAPI;
  const settingsLoadedRef = useRef(!isElectron);

  // Load persisted settings from Electron file storage on mount (localStorage used for web)
  useEffect(() => {
    if (!isElectron) return;
    loadSettingsAsync().then((s) => {
      settingsLoadedRef.current = true;
      if (s.avatarImageSrc != null) setAvatarImageSrc(s.avatarImageSrc);
      if (s.avatarSize != null) setAvatarSize(s.avatarSize);
      if (s.avatarShape != null) setAvatarShape(s.avatarShape);
      if (s.avatarDecor != null) setAvatarDecor(s.avatarDecor);
      if (s.glowColor != null) setGlowColor(s.glowColor);
      if (s.beautyMode != null) setBeautyMode(s.beautyMode);
      if (s.beautySettings != null) setBeautySettings(s.beautySettings);
      if (s.faceFilter != null) setFaceFilter(s.faceFilter);
      if (s.pipPos != null) setPipPos(s.pipPos);
      if (s.fullPagePipPos != null) setFullPagePipPos(s.fullPagePipPos);
      if (s.sidebarWidth != null) setSidebarWidth(s.sidebarWidth);
      if (s.previewWidth != null) setPreviewWidth(s.previewWidth);
      if (s.whiteboardHeight != null) setWhiteboardHeight(s.whiteboardHeight);
      if (s.micVolume != null) setMicVolume(s.micVolume);
      if (s.systemVolume != null) setSystemVolume(s.systemVolume);
      if (s.recordResolution != null) setRecordResolution(s.recordResolution);
      if (s.letterboxBackground != null) setLetterboxBackground(s.letterboxBackground);
      if (s.letterboxCustomImage != null) setLetterboxCustomImage(s.letterboxCustomImage);
      if (s.previewPosition != null) setPreviewPosition(s.previewPosition);
      if (s.fullPagePreviewPos != null) setFullPagePreviewPos(s.fullPagePreviewPos);
    });
  }, [isElectron]);
  const [showOutput, setShowOutput] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLiveMeetingModal, setShowLiveMeetingModal] = useState(false);
  const [micVolume, setMicVolume] = useState(() => loadSettings().micVolume ?? 100);
  const [systemVolume, setSystemVolume] = useState(() => loadSettings().systemVolume ?? 80);
  const [recordResolution, setRecordResolution] = useState<RecordResolution>(
    () => loadSettings().recordResolution ?? "1080p"
  );
  const [letterboxBackground, setLetterboxBackground] = useState<LetterboxBackground>(
    () => loadSettings().letterboxBackground ?? "black"
  );
  const [letterboxCustomImage, setLetterboxCustomImage] = useState<string | null>(
    () => loadSettings().letterboxCustomImage ?? null
  );
  const [previewPosition, setPreviewPosition] = useState<
    "top-left" | "top-right" | "bottom-left" | "bottom-right"
  >(() => loadSettings().previewPosition ?? "top-left");
  const [fullPagePreviewPos, setFullPagePreviewPos] = useState<{ x: number; y: number } | null>(
    () => loadSettings().fullPagePreviewPos ?? null
  );
  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [teleprompterPlaying, setTeleprompterPlaying] = useState(false);
  const [teleprompterScript, setTeleprompterScript] = useState(
    "Hook line.\n\nMain point one.\n\nMain point two.\n\nCall to action."
  );
  const [teleprompterSpeed, setTeleprompterSpeed] = useState(42);
  const [teleprompterFontSize, setTeleprompterFontSize] = useState(32);
  const [teleprompterOpacity, setTeleprompterOpacity] = useState(0.86);
  const [teleprompterWidth, setTeleprompterWidth] = useState(560);
  const [teleprompterNearCamera, setTeleprompterNearCamera] = useState(true);
  const [teleprompterPosition, setTeleprompterPosition] = useState<{ x: number; y: number } | null>(null);
  const [teleprompterPanelPosition, setTeleprompterPanelPosition] = useState<{ x: number; y: number } | null>(null);
  const [teleprompterLocked, setTeleprompterLocked] = useState(false);
  const [teleprompterResetSeq, setTeleprompterResetSeq] = useState(0);
  const [teleprompterAnchorRect, setTeleprompterAnchorRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const teleprompterChannelRef = useRef<BroadcastChannel | null>(null);
  const teleprompterWindowRef = useRef<Window | null>(null);
  const monitorWindowRef = useRef<Window | null>(null);
  const helperOpenInFlightRef = useRef<{ teleprompter: boolean; monitor: boolean }>({
    teleprompter: false,
    monitor: false,
  });
  const helperOpenRef = useRef<(kind: "teleprompter" | "monitor") => void>(() => undefined);
  const recordLoopLastAtRef = useRef(0);
  const letterboxCustomImgRef = useRef<HTMLImageElement | null>(null);
  const handleWhiteboardLayersChange = useCallback((layers: HTMLCanvasElement[]) => {
    whiteboardCanvasLayersRef.current = layers;
  }, []);

  useEffect(() => {
    if (!letterboxCustomImage) {
      letterboxCustomImgRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => { letterboxCustomImgRef.current = img; };
    img.onerror = () => { letterboxCustomImgRef.current = null; };
    img.src = letterboxCustomImage;
    return () => { letterboxCustomImgRef.current = null; };
  }, [letterboxCustomImage]);

  // Bring window to foreground on launch (macOS often leaves it behind) — only after app has mounted
  useEffect(() => {
    if (isElectron && typeof window !== "undefined") {
      window.focus();
    }
  }, [isElectron]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const drawLoopIdRef = useRef<number | null>(null);
  const previewDrawLoopIdRef = useRef<number | null>(null);
  const timerIdRef = useRef<number | null>(null);
  const recordingStartRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const hasScreen = !!activeScreenStream || !!persistentScreenVideoRef.current?.srcObject;
  const hasCamera = showPip;
  const keepFullStudioWhileRecording = showWhiteboard && whiteboardInPreview && !fullPageWhiteboard;
  const detachedHelpersEnabled = isElectron && !!activeScreenStream;

  useEffect(() => {
    if (!showTeleprompter || !teleprompterNearCamera || !showPip) {
      setTeleprompterAnchorRect(null);
      return;
    }
    let raf = 0;
    const updateRect = () => {
      const rect = pipRef.current?.getBoundingClientRect();
      setTeleprompterAnchorRect((prev) => {
        if (!rect) return prev === null ? prev : null;
        // Quantize values so tiny sub-pixel jitter doesn't trigger re-renders.
        const next = {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        if (
          prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height
        ) {
          return prev;
        }
        return next;
      });
      raf = requestAnimationFrame(updateRect);
    };
    raf = requestAnimationFrame(updateRect);
    return () => cancelAnimationFrame(raf);
  }, [showTeleprompter, teleprompterNearCamera, showPip]);

  const handleToggleTeleprompter = () => {
    setShowTeleprompter((prev) => {
      const next = !prev;
      if (next && detachedHelpersEnabled) helperOpenRef.current("teleprompter");
      if (!next) {
        setTeleprompterPlaying(false);
        const w = teleprompterWindowRef.current;
        if (w && "close" in w && typeof w.close === "function") {
          try {
            (w as Window).close();
          } catch {
            /* ignore */
          }
        }
        teleprompterWindowRef.current = null;
        void closeHelperByLabel("teleprompter-helper");
      }
      return next;
    });
  };

  const handleResetTeleprompter = () => {
    setTeleprompterPlaying(false);
    setTeleprompterResetSeq((prev) => prev + 1);
  };

  const handleSetTeleprompterNearCamera = (value: boolean) => {
    setTeleprompterNearCamera(value);
    if (value) setTeleprompterPosition(null);
  };

  const closeHelperWindows = useCallback(async () => {
    if (isElectron) {
      const api = (window as unknown as { electronAPI?: { closeHelperByLabel: (l: string) => Promise<void> } }).electronAPI;
      await api?.closeHelperByLabel?.("teleprompter-helper");
      await api?.closeHelperByLabel?.("recording-monitor");
      teleprompterWindowRef.current = null;
      monitorWindowRef.current = null;
      return;
    }
    const closeMaybe = (ref: typeof teleprompterWindowRef) => {
      const w = ref.current;
      if (!w) return;
      try {
        if ("close" in w && typeof w.close === "function") (w as Window).close();
      } catch {
        /* ignore */
      }
      ref.current = null;
    };
    closeMaybe(teleprompterWindowRef);
    closeMaybe(monitorWindowRef);
  }, [isElectron]);

  const closeHelperByLabel = useCallback(
    async (label: "teleprompter-helper" | "recording-monitor") => {
      if (!isElectron) return;
      try {
        const api = (window as unknown as { electronAPI?: { closeHelperByLabel: (l: string) => Promise<void> } }).electronAPI;
        await api?.closeHelperByLabel?.(label);
      } catch {
        /* ignore close errors */
      }
    },
    [isElectron]
  );

  const openHelperWindow = useCallback(
    async (kind: "teleprompter" | "monitor") => {
      if (helperOpenInFlightRef.current[kind]) return;
      helperOpenInFlightRef.current[kind] = true;
      const isTeleprompter = kind === "teleprompter";
      const label = isTeleprompter ? "teleprompter-helper" : "recording-monitor";
      const existingRef = isTeleprompter ? teleprompterWindowRef : monitorWindowRef;
      if (existingRef.current && "closed" in existingRef.current && existingRef.current.closed) {
        existingRef.current = null;
      }
      if (isElectron) {
        try {
          const api = (window as unknown as { electronAPI?: { openHelperWindow: (k: string) => Promise<void> } }).electronAPI;
          await api?.openHelperWindow?.(kind);
          helperOpenInFlightRef.current[kind] = false;
          return;
        } catch {
          // Fall back to browser popup behavior.
        }
      }
      if (existingRef.current && "focus" in existingRef.current) {
        existingRef.current.focus();
        helperOpenInFlightRef.current[kind] = false;
        return;
      }
      const popup = window.open(
        isTeleprompter ? TELEPROMPTER_HELPER_URL : MONITOR_HELPER_URL,
        label,
        isTeleprompter ? "popup=yes,width=760,height=240,left=180,top=240" : "popup=yes,width=100,height=100,left=24,top=280"
      );
      if (popup) {
        existingRef.current = popup;
      }
      helperOpenInFlightRef.current[kind] = false;
    },
    [isElectron]
  );

  const ensureHelperOpen = useCallback(
    (kind: "teleprompter" | "monitor") => {
      void openHelperWindow(kind);
    },
    [openHelperWindow]
  );
  helperOpenRef.current = ensureHelperOpen;

  const handleRecoverOverlays = useCallback(() => {
    if (!detachedHelpersEnabled) return;
    closeHelperWindows();
    window.setTimeout(() => {
      if (showTeleprompter) ensureHelperOpen("teleprompter");
    }, 80);
  }, [detachedHelpersEnabled, closeHelperWindows, showPip, showTeleprompter, ensureHelperOpen]);

  const handleToggleCameraFromControls = () => {
    if (showPip || !!monitorWindowRef.current) {
      stopCamera();
      return;
    }
    void startCamera();
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const teleprompterChannel = new BroadcastChannel(TELEPROMPTER_CHANNEL);
    teleprompterChannelRef.current = teleprompterChannel;

    const onTeleprompterMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "teleprompter-control") {
        if (typeof payload.playing === "boolean") setTeleprompterPlaying(payload.playing);
        if (typeof payload.speed === "number") setTeleprompterSpeed(Math.max(10, Math.min(180, payload.speed)));
        if (typeof payload.resetSeq === "number") setTeleprompterResetSeq(payload.resetSeq);
      } else if (payload.type === "teleprompter-close") {
        setShowTeleprompter(false);
        setTeleprompterPlaying(false);
        teleprompterWindowRef.current = null;
        void closeHelperByLabel("teleprompter-helper");
      }
    };
    teleprompterChannel.addEventListener("message", onTeleprompterMessage);
    return () => {
      teleprompterChannel.removeEventListener("message", onTeleprompterMessage);
      teleprompterChannel.close();
      teleprompterChannelRef.current = null;
    };
  }, [closeHelperByLabel]);

  useEffect(() => {
    if (!detachedHelpersEnabled) {
      const w = teleprompterWindowRef.current;
      if (w && "close" in w && typeof w.close === "function") {
        try {
          (w as Window).close();
        } catch {
          /* ignore */
        }
      }
      teleprompterWindowRef.current = null;
      void closeHelperByLabel("teleprompter-helper");
      return;
    }
    if (showTeleprompter) ensureHelperOpen("teleprompter");
    else {
      const w = teleprompterWindowRef.current;
      if (w && "close" in w && typeof w.close === "function") {
        try {
          (w as Window).close();
        } catch {
          /* ignore */
        }
      }
      teleprompterWindowRef.current = null;
      void closeHelperByLabel("teleprompter-helper");
    }
  }, [detachedHelpersEnabled, showTeleprompter, ensureHelperOpen, closeHelperByLabel]);

  useEffect(() => {
    if (!detachedHelpersEnabled) {
      const w = monitorWindowRef.current;
      if (w && "close" in w && typeof w.close === "function") {
        try {
          (w as Window).close();
        } catch {
          /* ignore */
        }
      }
      monitorWindowRef.current = null;
      void closeHelperByLabel("recording-monitor");
      return;
    }
    const w = monitorWindowRef.current;
    if (w && "close" in w && typeof w.close === "function") {
      try {
        (w as Window).close();
      } catch {
        /* ignore */
      }
    }
    monitorWindowRef.current = null;
    void closeHelperByLabel("recording-monitor");
  }, [detachedHelpersEnabled, closeHelperByLabel]);

  useEffect(() => {
    const channel = teleprompterChannelRef.current;
    if (!channel) return;
    channel.postMessage({
      type: "teleprompter-state",
      visible: showTeleprompter,
      detached: detachedHelpersEnabled,
      overlayMode: "guaranteed",
      script: teleprompterScript,
      playing: teleprompterPlaying,
      speed: teleprompterSpeed,
      fontSize: teleprompterFontSize,
      opacity: teleprompterOpacity,
      width: teleprompterWidth,
      locked: teleprompterLocked,
      resetSeq: teleprompterResetSeq,
    });
  }, [
    showTeleprompter,
    detachedHelpersEnabled,
    teleprompterScript,
    teleprompterPlaying,
    teleprompterSpeed,
    teleprompterFontSize,
    teleprompterOpacity,
    teleprompterWidth,
    teleprompterLocked,
    teleprompterResetSeq,
  ]);

  // Compact only when Start Recording with screen share; never on Capture Screen or Whiteboard

  const handleToggleTeleprompterLock = () => {
    setTeleprompterLocked((prev) => !prev);
  };

  const cameraOverlayRef = useRef<HTMLCanvasElement>(null);
  const OVERLAP_BUFFER = 60;
  const PREVIEW_BASE_WIDTH = 320;
  const PREVIEW_BASE_HEIGHT = 180;
  const previewScale =
    mainLayoutPortalRect && !fullPageWhiteboard
      ? Math.max(
          0.45,
          Math.min(
            1,
            Math.min(
              mainLayoutPortalRect.width / PREVIEW_BASE_WIDTH,
              mainLayoutPortalRect.height / PREVIEW_BASE_HEIGHT
            )
          )
        )
      : 1;
  const avatarSizeDisplayRaw = !fullPageWhiteboard
    ? Math.max(32, Math.round(avatarSize))
    : Math.max(32, Math.round(avatarSize * previewScale));
  const avatarSizeDisplay = avatarSizeDisplayRaw;
  // Rect shape: landscape 16:9 (width > height)
  const LANDSCAPE_ASPECT = 16 / 9;
  const avatarWidthDisplay =
    avatarShape === "circle" ? avatarSizeDisplay : Math.round(avatarSizeDisplay * LANDSCAPE_ASPECT);
  const avatarHeightDisplay = avatarSizeDisplay;

  const drawComposite = useCallback(
    (forceRecordRes = false) => {
      const screenVideo = persistentScreenVideoRef.current;
      const cameraVideoMain = cameraVideoRef.current;
      const cameraVideoSource = cameraSourceVideoRef.current;
      // Prefer cameraSourceVideoRef for recording - it's always mounted when we have camera, decodes ahead
      const forRecording = forceRecordRes || isRecording;
      const cameraVideo =
        (forRecording && cameraVideoSource && cameraVideoSource.readyState >= 2 && cameraVideoSource.videoWidth > 0
          ? cameraVideoSource
          : null) ??
        (cameraVideoMain && cameraVideoMain.readyState >= 2 && cameraVideoMain.videoWidth > 0
          ? cameraVideoMain
          : null) ??
        (cameraVideoSource && cameraVideoSource.readyState >= 2 && cameraVideoSource.videoWidth > 0
          ? cameraVideoSource
          : null) ??
        cameraVideoMain ??
        cameraVideoSource;
      const composite = compositeRef.current;
      const pip = pipRef.current;
      const avatarImg = avatarImgRef.current;
      const preview = previewRef.current;
      if (!preview || !composite) return;

      const prevW = preview.offsetWidth;
      const prevH = preview.offsetHeight;
      if (prevW <= 0 || prevH <= 0) return;
      // Skip camera during layout transition when preview is collapsed (avoids wrong scale/position)
      const previewStable = prevW >= 50 && prevH >= 50;
      const res = RECORD_RESOLUTIONS[recordResolution] ?? RECORD_RESOLUTIONS["1080p"];
      const useRecordRes = forceRecordRes || isRecording;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = useRecordRes ? res.w : Math.round(prevW * dpr);
      const h = useRecordRes ? res.h : Math.round(prevH * dpr);
      const scaleX = w / prevW;
      const scaleY = h / prevH;
      if (composite.width !== w || composite.height !== h) {
        composite.width = w;
        composite.height = h;
      }
      // Keep display size consistent to avoid shrink/blink when recording starts
      composite.style.width = `${prevW}px`;
      composite.style.height = `${prevH}px`;
      const ctx = composite.getContext("2d", { alpha: false });
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, w, h);
      if (screenVideo?.srcObject && screenVideo.readyState >= 2) {
        drawLetterboxBg(ctx, letterboxBackground, w, h, letterboxCustomImgRef.current);
        const sw = screenVideo.videoWidth || w;
        const sh = screenVideo.videoHeight || h;
        const scale = Math.min(w / sw, h / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;
        ctx.drawImage(screenVideo, 0, 0, sw, sh, dx, dy, dw, dh);
      } else if (useRecordRes && !(fullPageWhiteboard && !activeScreenStream)) {
        drawLetterboxBg(ctx, letterboxBackground, w, h, letterboxCustomImgRef.current);
      } else if (useRecordRes && fullPageWhiteboard && !activeScreenStream) {
        drawLetterboxBg(ctx, letterboxBackground, w, h, letterboxCustomImgRef.current);
        const whiteboardLayers = whiteboardCanvasLayersRef.current.filter((layer) => layer.width > 0 && layer.height > 0);
        for (const layer of whiteboardLayers) {
          const lw = layer.width;
          const lh = layer.height;
          const lscale = Math.min(w / lw, h / lh);
          const ldw = lw * lscale;
          const ldh = lh * lscale;
          const ldx = (w - ldw) / 2;
          const ldy = (h - ldh) / 2;
          ctx.drawImage(layer, 0, 0, lw, lh, ldx, ldy, ldw, ldh);
        }
      }

      // Always composite for recording and in-app capture preview.
      // Detached helper only controls desktop overlay UX, not in-app preview effects.
      const shouldCompositeCamera =
        forceRecordRes || !detachedHelpersEnabled || (!fullPageWhiteboard && !!activeScreenStream);
      const useAvatarImage = shouldCompositeCamera && showPip && !!avatarImageSrc && avatarImg?.complete;
      const useCamera =
        shouldCompositeCamera &&
        showPip &&
        !useAvatarImage &&
        cameraVideo &&
        cameraVideo.srcObject &&
        cameraVideo.readyState >= 2;
      if (useCamera && cameraVideo) {
        let cache = lastCameraFrameCanvasRef.current;
        if (!cache) {
          cache = document.createElement("canvas");
          lastCameraFrameCanvasRef.current = cache;
        }
        if (cache.width !== cameraVideo.videoWidth || cache.height !== cameraVideo.videoHeight) {
          cache.width = cameraVideo.videoWidth;
          cache.height = cameraVideo.videoHeight;
        }
        const cacheCtx = cache.getContext("2d");
        if (cacheCtx && cameraVideo.videoWidth > 0 && cameraVideo.videoHeight > 0) {
          cacheCtx.drawImage(cameraVideo, 0, 0, cache.width, cache.height);
        }
      }
      const cachedCameraCanvas = lastCameraFrameCanvasRef.current;
      const hasCached = !!cachedCameraCanvas && cachedCameraCanvas.width > 0 && cachedCameraCanvas.height > 0;
      const whiteboardRecording = forceRecordRes && !activeScreenStream;
      const draggingDuringScreenRecord =
        pipDraggingRef.current && forceRecordRes && activeScreenStream;
      const useCachedCamera =
        shouldCompositeCamera &&
        showPip &&
        !useAvatarImage &&
        hasCached &&
        (whiteboardRecording || draggingDuringScreenRecord || !useCamera);
      const pipSource = useAvatarImage
        ? avatarImg
        : useCamera
          ? cameraVideo
          : useCachedCamera
            ? cachedCameraCanvas
            : null;
      if ((useAvatarImage || useCamera || useCachedCamera) && previewStable && pipSource) {
        const prevRect = preview.getBoundingClientRect();
        const fallbackPos = fullPageWhiteboard ? fullPagePipPosRef.current : pipPosRef.current;
        // When fullPage+activeScreenStream, fullPagePipPos is in screen coords; else relative to preview/portal
        const fallbackLeft =
          fullPageWhiteboard && activeScreenStream
            ? fallbackPos.x
            : prevRect.left + fallbackPos.x;
        const fallbackTop =
          fullPageWhiteboard && activeScreenStream
            ? fallbackPos.y
            : prevRect.top + fallbackPos.y;
        // When pip exists, use DOM position (actual); when offset (portal != composite), use fallback for composite.
        const useFallbackForComposite = fullPageWhiteboard && activeScreenStream;
        const rect = pip && !useFallbackForComposite
          ? pip.getBoundingClientRect()
          : {
              left: fallbackLeft,
              top: fallbackTop,
              width: avatarWidthDisplay,
              height: avatarHeightDisplay,
              right: fallbackLeft + avatarWidthDisplay,
              bottom: fallbackTop + avatarHeightDisplay,
            };
        const scale = Math.min(scaleX, scaleY);
        let x = (rect.left - prevRect.left) * scaleX;
        let y = (rect.top - prevRect.top) * scaleY;
        const pw = rect.width * scale;
        const ph = rect.height * scale;
        // When fullPage+activeScreenStream, camera and preview are independent: if camera is outside preview, skip drawing on composite (DOM overlay shows it)
        const buf = 24;
        const pipWellInsidePreview =
          rect.left >= prevRect.left + buf &&
          rect.right <= prevRect.right - buf &&
          rect.top >= prevRect.top + buf &&
          rect.bottom <= prevRect.bottom - buf;
        if (!pipWellInsidePreview && fullPageWhiteboard && activeScreenStream && !forceRecordRes) {
          // Don't draw camera on composite; it's shown by the separate DOM overlay
        } else {
        // Clamp only when not recording: during recording, preserve dragged position (canvas clips if outside)
        const recordingWithScreen = forceRecordRes && activeScreenStream;
        if (!recordingWithScreen) {
          x = Math.max(0, Math.min(x, w - pw));
          y = Math.max(0, Math.min(y, h - ph));
        }
      const isCircle = avatarShape === "circle";

      ctx.save();
      ctx.beginPath();
      if (isCircle) {
        const cx = x + pw / 2;
        const cy = y + ph / 2;
        const r = Math.min(pw, ph) / 2;
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      } else {
        roundRectPath(ctx, x, y, pw, ph, Math.min(pw, ph) * 0.2);
      }
      ctx.closePath();
      ctx.clip();
      if (beautyMode) ctx.filter = beautySettingsToFilter(beautySettings);
      if (useAvatarImage && avatarImg && avatarImg.naturalWidth) {
        const scale = Math.max(
          pw / avatarImg.naturalWidth,
          ph / avatarImg.naturalHeight
        );
        const sw = avatarImg.naturalWidth * scale;
        const sh = avatarImg.naturalHeight * scale;
        ctx.drawImage(avatarImg, x - (sw - pw) / 2, y - (sh - ph) / 2, sw, sh);
      } else if (pipSource) {
        const vw =
          pipSource instanceof HTMLVideoElement
            ? pipSource.videoWidth || pw
            : (pipSource as HTMLImageElement).naturalWidth || pw;
        const vh =
          pipSource instanceof HTMLVideoElement
            ? pipSource.videoHeight || ph
            : (pipSource as HTMLImageElement).naturalHeight || ph;
        const scale = Math.max(pw / vw, ph / vh);
        const drawW = vw * scale;
        const drawH = vh * scale;
        const dx = x + (pw - drawW) / 2;
        const dy = y + (ph - drawH) / 2;
        ctx.drawImage(pipSource, 0, 0, vw, vh, dx, dy, drawW, drawH);
        if (faceFilter !== "none" && !useAvatarImage) {
          try {
            drawFaceFilter(ctx, faceLandmarksRef.current, faceFilter, dx, dy, drawW, drawH);
          } catch {
            /* face filter may fail if landmarks invalid */
          }
        }
      }
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      if (isCircle) {
        const cx = x + pw / 2;
        const cy = y + ph / 2;
        const r = Math.min(pw, ph) / 2;
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      } else {
        roundRectPath(ctx, x, y, pw, ph, Math.min(pw, ph) * 0.2);
      }
      if (avatarDecor !== "none") {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = avatarDecor === "simple" ? 4 : 3;
        if (avatarDecor === "dashed") ctx.setLineDash([8, 6]);
        if (avatarDecor === "glow") {
          ctx.shadowColor = hexToRgba(glowColor, 0.6);
          ctx.shadowBlur = 24;
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    }
  },
    [
      showPip,
      avatarImageSrc,
      avatarShape,
      avatarDecor,
      glowColor,
      beautyMode,
      beautySettings,
      faceFilter,
      activeScreenStream,
      cameraStream,
      recordResolution,
      letterboxBackground,
      letterboxCustomImage,
      isRecording,
      fullPageWhiteboard,
      detachedHelpersEnabled,
      pipPos,
      fullPagePipPos,
      avatarSizeDisplay,
      avatarWidthDisplay,
      avatarHeightDisplay,
    ]
  );

  const drawCompositeRef = useRef(drawComposite);
  drawCompositeRef.current = drawComposite;

  const activePipPos = fullPageWhiteboard ? fullPagePipPos : pipPos;
  const cameraViewportPos =
    fullPageWhiteboard
      ? activeScreenStream
        ? fullPagePipPos
        : portalRect
          ? { x: portalRect.left + fullPagePipPos.x, y: portalRect.top + fullPagePipPos.y }
          : fullPagePipPos
      : mainLayoutPortalRect
        ? { x: mainLayoutPortalRect.left + pipPos.x, y: mainLayoutPortalRect.top + pipPos.y }
        : pipPos;
  const cameraOutsidePreview =
    fullPageWhiteboard &&
    activeScreenStream &&
    portalRect &&
    (activePipPos.x + avatarWidthDisplay <= portalRect.left + OVERLAP_BUFFER ||
      activePipPos.x >= portalRect.right - OVERLAP_BUFFER ||
      activePipPos.y + avatarHeightDisplay <= portalRect.top + OVERLAP_BUFFER ||
      activePipPos.y >= portalRect.bottom - OVERLAP_BUFFER);
  // Keep camera source video mounted whenever we have camera - so it decodes ahead of recording
  const showCameraSourceVideo = showPip && (!fullPageWhiteboard || isRecording || !!cameraStream);
  const captureWebcamHidden =
    !fullPageWhiteboard && !!activeScreenStream && !avatarImageSrc;

  const drawCameraOverlay = useCallback(() => {
    const canvas = cameraOverlayRef.current;
    const video = cameraVideoRef.current ?? cameraSourceVideoRef.current;
    const img = avatarImgRef.current;
    if (!canvas || (!video?.srcObject && !img?.complete)) return;
    const useAvatarImage = showPip && !!avatarImageSrc && img?.complete;
    const useCamera =
      showPip &&
      !useAvatarImage &&
      video?.srcObject &&
      video.readyState >= 2;
    const pipSource = useAvatarImage ? img : video;
    if (!pipSource || (!useAvatarImage && !useCamera)) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(avatarWidthDisplay * dpr);
    const h = Math.round(avatarHeightDisplay * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${avatarWidthDisplay}px`;
    canvas.style.height = `${avatarHeightDisplay}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const pw = avatarWidthDisplay * dpr;
    const ph = avatarHeightDisplay * dpr;
    const isCircle = avatarShape === "circle";
    ctx.save();
    ctx.beginPath();
    if (isCircle) {
      ctx.arc(pw / 2, ph / 2, Math.min(pw, ph) / 2, 0, Math.PI * 2);
    } else {
      roundRectPath(ctx, 0, 0, pw, ph, Math.min(pw, ph) * 0.2);
    }
    ctx.closePath();
    ctx.clip();
    if (beautyMode) ctx.filter = beautySettingsToFilter(beautySettings);
    if (useAvatarImage && img?.naturalWidth) {
      const s = Math.max(pw / img.naturalWidth, ph / img.naturalHeight);
      const sw = img.naturalWidth * s;
      const sh = img.naturalHeight * s;
      ctx.drawImage(img, (pw - sw) / 2, (ph - sh) / 2, sw, sh);
    } else if (pipSource && video) {
      const vw = video.videoWidth || pw;
      const vh = video.videoHeight || ph;
      const s = Math.max(pw / vw, ph / vh);
      const drawW = vw * s;
      const drawH = vh * s;
      const dx = (pw - drawW) / 2;
      const dy = (ph - drawH) / 2;
      ctx.drawImage(video, 0, 0, vw, vh, dx, dy, drawW, drawH);
      if (faceFilter !== "none") {
        try {
          drawFaceFilter(ctx, faceLandmarksRef.current, faceFilter, dx, dy, drawW, drawH);
        } catch {
          /* face filter may fail if landmarks invalid */
        }
      }
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    if (isCircle) {
      ctx.arc(pw / 2, ph / 2, Math.min(pw, ph) / 2, 0, Math.PI * 2);
    } else {
      roundRectPath(ctx, 0, 0, pw, ph, Math.min(pw, ph) * 0.2);
    }
    if (avatarDecor !== "none") {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = avatarDecor === "simple" ? 4 : 3;
      if (avatarDecor === "dashed") ctx.setLineDash([8, 6]);
      if (avatarDecor === "glow") {
        ctx.shadowColor = hexToRgba(glowColor, 0.6);
        ctx.shadowBlur = 24;
      }
      ctx.stroke();
    }
    ctx.restore();
  }, [
    showPip,
    avatarImageSrc,
    avatarShape,
    avatarDecor,
    glowColor,
    beautyMode,
    beautySettings,
    faceFilter,
    avatarWidthDisplay,
    avatarHeightDisplay,
  ]);

  const drawCameraOverlayRef = useRef(drawCameraOverlay);
  drawCameraOverlayRef.current = drawCameraOverlay;

  const prevMainPreviewSizeRef = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (fullPageWhiteboard || !showPip || pipDragging || isRecording || !mainLayoutPortalRect) {
      if (fullPageWhiteboard || !showPip) prevMainPreviewSizeRef.current = null;
      return;
    }
    const current = {
      width: Math.max(1, Math.round(mainLayoutPortalRect.width)),
      height: Math.max(1, Math.round(mainLayoutPortalRect.height)),
    };
    const prev = prevMainPreviewSizeRef.current;
    if (!prev) {
      prevMainPreviewSizeRef.current = current;
      return;
    }
    if (prev.width === current.width && prev.height === current.height) return;
    const scaleX = current.width / prev.width;
    const scaleY = current.height / prev.height;
    setPipPos((prevPos) => ({
      x: Math.round(prevPos.x * scaleX),
      y: Math.round(prevPos.y * scaleY),
    }));
    prevMainPreviewSizeRef.current = current;
  }, [fullPageWhiteboard, showPip, pipDragging, isRecording, mainLayoutPortalRect]);

  useEffect(() => {
    const shouldDrawEffects =
      cameraOutsidePreview ||
      (fullPageWhiteboard && !activeScreenStream && !avatarImageSrc && showPip) ||
      (showPip && !activeScreenStream && !avatarImageSrc && faceFilter !== "none" && !!mainLayoutPortalRect) ||
      (faceFilter !== "none" && showPip && !avatarImageSrc);
    if (!shouldDrawEffects || !showPip) return;
    let id: number;
    const loop = () => {
      drawCameraOverlayRef.current?.();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [cameraOutsidePreview, showPip, fullPageWhiteboard, activeScreenStream, avatarImageSrc, faceFilter, mainLayoutPortalRect]);

  // Face detection for sunglasses/heart/vampire filter
  useEffect(() => {
    if (faceFilter === "none" || !showPip || avatarImageSrc) {
      faceLandmarksRef.current = null;
      return;
    }
    const video = cameraVideoRef.current ?? cameraSourceVideoRef.current;
    if (!video?.srcObject) return;
    let cancelled = false;
    let rafId = 0;
    const run = async () => {
      try {
        const landmarker = await initFaceLandmarker();
        if (cancelled) return;
        const loop = () => {
          if (cancelled) return;
          const v = cameraVideoRef.current ?? cameraSourceVideoRef.current;
          if (!v?.srcObject || v.readyState < 2) {
            rafId = requestAnimationFrame(loop);
            return;
          }
          try {
            const result = landmarker.detectForVideo(v, nextVideoTimestamp());
            if (result?.faceLandmarks?.[0]) faceLandmarksRef.current = result.faceLandmarks[0];
            else faceLandmarksRef.current = null;
          } catch {
            faceLandmarksRef.current = null;
          }
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
      } catch {
        faceLandmarksRef.current = null;
      }
    };
    void run();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      faceLandmarksRef.current = null;
    };
  }, [faceFilter, showPip, avatarImageSrc, cameraStream]);

  useEffect(() => {
    if (!showPip || pipDragging || isRecording) return;
    const preview = previewRef.current;
    if (!preview || fullPageWhiteboard) return;
    const rect = preview.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setPipPos((prev) => {
      const next = {
        x: Math.max(0, Math.min(rect.width - avatarWidthDisplay, prev.x)),
        y: Math.max(0, Math.min(rect.height - avatarHeightDisplay, prev.y)),
      };
      return next.x === prev.x && next.y === prev.y ? prev : next;
    });
  }, [showPip, pipDragging, fullPageWhiteboard, avatarWidthDisplay, avatarHeightDisplay, mainLayoutPortalRect, isRecording]);

  useEffect(() => {
    if (!showPip || pipDragging || !fullPageWhiteboard) return;
    if (activeScreenStream) {
      setFullPagePipPos((prev) => {
        const next = {
          x: Math.max(0, Math.min(window.innerWidth - avatarWidthDisplay, prev.x)),
          y: Math.max(0, Math.min(window.innerHeight - avatarHeightDisplay, prev.y)),
        };
        return next.x === prev.x && next.y === prev.y ? prev : next;
      });
      return;
    }
    const container = fullPageContentRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setFullPagePipPos((prev) => {
      const next = {
        x: Math.max(0, Math.min(rect.width - avatarWidthDisplay, prev.x)),
        y: Math.max(0, Math.min(rect.height - avatarHeightDisplay, prev.y)),
      };
      return next.x === prev.x && next.y === prev.y ? prev : next;
    });
  }, [showPip, pipDragging, fullPageWhiteboard, activeScreenStream, avatarWidthDisplay, avatarHeightDisplay, fullPagePreviewPos]);

  const stopScreenShare = () => {
    if (isRecording) {
      stopRecording();
    }
    const stream = whiteboardScreenStream ?? previewScreenStream;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    setWhiteboardScreenStream(null);
    setPreviewScreenStream(null);
    if (persistentScreenVideoRef.current?.srcObject) {
      persistentScreenVideoRef.current.srcObject = null;
    }
    if (screenVideoRef.current?.srcObject) {
      screenVideoRef.current.srcObject = null;
    }
    if (isElectron) {
      setNormalMode().catch(() => undefined);
    }
  };

  const captureScreen = async () => {
    setCaptureError(null);
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCaptureError("Screen capture is not available. Use HTTPS or localhost.");
      return;
    }
    const applyCapturedStream = (stream: MediaStream) => {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          setPreviewScreenStream((s) => (s === stream ? null : s));
          setWhiteboardScreenStream((w) => (w === stream ? null : w));
          if (isElectron && !isRecording) setNormalMode().catch(() => undefined);
        };
      }
      setWhiteboardScreenStream(stream);
      setPreviewScreenStream(stream);
      setShowTeleprompter(false);
      setTeleprompterPlaying(false);
      setShowPip(true);
      // Auto-start camera when capturing so user can record immediately
      if (!cameraStream && navigator.mediaDevices?.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: true }).then((camStream) => {
          setCameraStream(camStream);
          setCaptureError(null);
        }).catch(() => {});
      }
    };
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      applyCapturedStream(stream);
    } catch (err: unknown) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        applyCapturedStream(stream);
      } catch (err2: unknown) {
        const msg =
          err2 instanceof Error
            ? err2.message
            : "Permission denied";
        setCaptureError(
          msg.includes("denied") || msg.includes("NotAllowed")
            ? "Screen capture denied. On macOS, enable Screen Recording for this app in System Settings → Privacy & Security."
            : msg
        );
      }
    }
  };

  const startCamera = async () => {
    if (avatarImageSrc) {
      setShowPip(true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCaptureError("Camera is not available. Use HTTPS or localhost.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      setCameraStream(stream);
      setShowPip(true);
      setCaptureError(null);
    } catch (err) {
      console.error("Camera failed:", err);
      setCaptureError(err instanceof Error ? err.message : "Camera permission denied");
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      setCameraStream(null);
    }
    if (cameraVideoRef.current?.srcObject) {
      cameraVideoRef.current.srcObject = null;
    }
    if (cameraSourceVideoRef.current?.srcObject) {
      cameraSourceVideoRef.current.srcObject = null;
    }
    const monitor = monitorWindowRef.current;
    if (monitor && "close" in monitor && typeof monitor.close === "function") {
      try {
        (monitor as Window).close();
      } catch {
        /* ignore */
      }
    }
    void closeHelperByLabel("recording-monitor");
    monitorWindowRef.current = null;
    setShowPip(false);
    setAvatarImageSrc(null);
  };

  const handleAvatarImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarImageSrc(reader.result as string);
      setShowPip(true);
    };
    reader.readAsDataURL(file);
  };

  const clearAvatarImage = () => {
    setAvatarImageSrc(null);
    if (!cameraStream) setShowPip(false);
  };

  const startRecording = async () => {
    pipPosRef.current = pipPos;
    fullPagePipPosRef.current = fullPagePipPos;
    // Shared Window (getDisplayMedia) on Preview page branch.
    const screenVideo = persistentScreenVideoRef.current;
    let composite = compositeRef.current;
    let preview = previewRef.current;
    const hasContent = activeScreenStream || screenVideo?.srcObject || showPip;
    if (!hasContent) return;
    if (!preview || !composite) return;

    const res = RECORD_RESOLUTIONS[recordResolution] ?? RECORD_RESOLUTIONS["1080p"];
    composite.width = res.w;
    composite.height = res.h;
    // Draw several frames before capture - ensures valid pixel data (fixes "Unsupported pixel format: -1" in Electron)
    drawCompositeRef.current?.(true);
    drawCompositeRef.current?.(true);
    drawCompositeRef.current?.(true);

    const targetFps = 30;
    const frameMs = 1000 / targetFps;
    const loop = () => {
      recordLoopLastAtRef.current = performance.now();
      drawCompositeRef.current?.(true);
      drawLoopIdRef.current = window.setTimeout(loop, frameMs) as unknown as number;
    };
    drawLoopIdRef.current = window.setTimeout(loop, frameMs) as unknown as number;

    const canvasStream = composite.captureStream(30);
    const audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    audioCtxRef.current = audioCtx;
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const micSource = audioCtx.createMediaStreamSource(micStream);
      const micGain = audioCtx.createGain();
      micGain.gain.value = micVolume / 100;
      micSource.connect(micGain);
      micGain.connect(dest);
    } catch {
      /* mic not available */
    }

    const screenAudio = activeScreenStream?.getAudioTracks?.()?.[0];
    if (screenAudio) {
      const sysSource = audioCtx.createMediaStreamSource(
        new MediaStream([screenAudio])
      );
      const sysGain = audioCtx.createGain();
      sysGain.gain.value = systemVolume / 100;
      sysSource.connect(sysGain);
      sysGain.connect(dest);
    }

    const mixedTracks = dest.stream.getAudioTracks();
    if (mixedTracks.length) canvasStream.addTrack(mixedTracks[0]);

    const videoBitrate = RECORD_BITRATES[recordResolution] ?? RECORD_BITRATES["1080p"];
    // Safari: video/mp4 native. Chrome/Electron: WebM (VP8 preferred, VP9 can cause "Unsupported pixel format")
    const mimeType = MediaRecorder.isTypeSupported("video/mp4")
      ? "video/mp4"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
        ? "video/webm;codecs=vp8"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm";
    let mediaRecorder: MediaRecorder;
    try {
      mediaRecorder = new MediaRecorder(canvasStream, {
        videoBitsPerSecond: videoBitrate,
        mimeType,
      });
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "Failed to initialize recorder");
      return;
    }
    mediaRecorderRef.current = mediaRecorder;
    recordedChunksRef.current = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) recordedChunksRef.current.push(e.data);
    };
    mediaRecorder.onstop = () => {
      if (drawLoopIdRef.current != null) {
        clearTimeout(drawLoopIdRef.current);
        drawLoopIdRef.current = null;
      }
      if (timerIdRef.current) clearInterval(timerIdRef.current);
      audioCtxRef.current?.close();
      setIsRecording(false);
      setIsRecordingPaused(false);
      if (isElectron) void setNormalMode();
      const chunks = recordedChunksRef.current;
      const recordedMime = mediaRecorder.mimeType || "video/webm";
      requestAnimationFrame(() => {
        const blob = new Blob(chunks, { type: recordedMime });
        clipIdRef.current += 1;
        setRecordedClips((prev) =>
          [...prev, { id: clipIdRef.current, blob }].slice(-3)
        );
        setShowOutput(true);
      });
    };

    try {
      mediaRecorder.start(1000);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "Failed to start recorder");
      return;
    }
    recordingStartRef.current = Date.now();
    setRecordingTime(0);
    setIsRecording(true);
    // No resize on Start Recording - keep same window (already compacted after Capture Screen)
    timerIdRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartRef.current) / 1000);
      recordingTimeElapsedRef.current = elapsed;
      setRecordingTime(elapsed);
    }, 1000);
  };

  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr?.state === "recording" || mr?.state === "paused") {
      mr.requestData();
      mr.stop();
    }
  };

  const pauseRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr?.state === "recording") {
      mr.pause();
      if (timerIdRef.current) {
        clearInterval(timerIdRef.current);
        timerIdRef.current = null;
      }
      setRecordingTime(recordingTimeElapsedRef.current);
      setIsRecordingPaused(true);
    }
  };

  const resumeRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr?.state === "paused") {
      mr.resume();
      const elapsed = recordingTime;
      recordingStartRef.current = Date.now() - elapsed * 1000;
      timerIdRef.current = window.setInterval(() => {
        const e = Math.floor((Date.now() - recordingStartRef.current) / 1000);
        recordingTimeElapsedRef.current = e;
        setRecordingTime(e);
      }, 1000);
      setIsRecordingPaused(false);
    }
  };

  const toggleRecord = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  const handleOpenWhiteboardRequest = () => {
    if (isCompact) {
      // In compact mode the confirmation dialog can cover most of the viewport
      // and feel like a freeze; default to opening whiteboard in sidebar.
      setShowWhiteboard(true);
      setWhiteboardInPreview(false);
      setShowUseInPreviewDialog(false);
      return;
    }
    setShowUseInPreviewDialog(true);
  };

  const openFullPageWhiteboard = () => {
    const prev = previewRef.current;
    const content = fullPageContentRef.current;
    if (prev && content) {
      const pr = prev.getBoundingClientRect();
      const cr = content.getBoundingClientRect();
      if (pr.width > 0 && pr.height > 0) {
        setFullPagePipPos({
          x: pipPos.x * (cr.width / pr.width),
          y: pipPos.y * (cr.height / pr.height),
        });
      }
    }
  };

  const closeFullPageWhiteboard = () => {};

  const handleUseInPreviewChoice = (useInPreview: boolean) => {
    setShowWhiteboard(true);
    setWhiteboardInPreview(useInPreview);
    setShowUseInPreviewDialog(false);
  };

  const handleCloseWhiteboard = () => {
    setShowWhiteboard(false);
    setWhiteboardInPreview(false);
  };

  const downloadRecording = (blob: Blob, ext: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dreamwork-recording.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyRecording = async (blob: Blob) => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "video/webm": blob }),
      ]);
    } catch {
      /* clipboard may not support video */
    }
  };

  // Persistent screen video: always mounted so stream survives layout switches (Whiteboard <-> Preview)
  useEffect(() => {
    const v = persistentScreenVideoRef.current;
    if (!v) return;
    if (activeScreenStream) {
      v.srcObject = activeScreenStream;
      v.play().catch(() => {});
    } else {
      v.srcObject = null;
    }
  }, [activeScreenStream]);

  // Sync layout-specific video from persistent ref for display; drawComposite uses persistent ref
  useEffect(() => {
    const v = screenVideoRef.current;
    if (!v) return;
    if (activeScreenStream) {
      v.srcObject = activeScreenStream;
      v.play().catch(() => {});
    } else {
      v.srcObject = null;
    }
  }, [activeScreenStream, fullPageWhiteboard]);

  useEffect(() => {
    if (!showPip || !activeScreenStream || isRecording) {
      if (previewDrawLoopIdRef.current) {
        cancelAnimationFrame(previewDrawLoopIdRef.current);
        previewDrawLoopIdRef.current = null;
      }
      return;
    }
    const loop = () => {
      drawComposite();
      previewDrawLoopIdRef.current = requestAnimationFrame(loop);
    };
    previewDrawLoopIdRef.current = requestAnimationFrame(loop);
    return () => {
      if (previewDrawLoopIdRef.current) {
        cancelAnimationFrame(previewDrawLoopIdRef.current);
        previewDrawLoopIdRef.current = null;
      }
    };
  }, [showPip, activeScreenStream, isRecording, drawComposite]);

  // Track rect for full-page portal: preview box when activeScreenStream, else full content
  useLayoutEffect(() => {
    if (!fullPageWhiteboard || !showPip) {
      setPortalRect(null);
      return;
    }
    const el = activeScreenStream ? previewRef.current : fullPageContentRef.current;
    if (!el) return;
    const update = () => {
      const target = activeScreenStream ? previewRef.current : fullPageContentRef.current;
      if (target) setPortalRect(target.getBoundingClientRect());
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [fullPageWhiteboard, showPip, activeScreenStream, fullPagePreviewPos]);

  // Portal main layout camera (iframe or overlay can block events; portal ensures camera receives them)
  useLayoutEffect(() => {
    if (fullPageWhiteboard || !showPip) {
      setMainLayoutPortalRect(null);
      return;
    }
    const el = previewRef.current;
    const update = () => {
      const e = previewRef.current;
      if (e) setMainLayoutPortalRect(e.getBoundingClientRect());
    };
    if (!el) {
      const id = requestAnimationFrame(update);
      return () => cancelAnimationFrame(id);
    }
    update();
    // Run again after paint so rect is ready immediately (fixes ~30s anchor delay)
    const id0 = requestAnimationFrame(update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    // Update on scroll so camera stays aligned when preview scrolls
    let scrollParent: Element | null = el.parentElement;
    while (scrollParent) {
      const { overflowY, overflow } = getComputedStyle(scrollParent);
      if (overflowY === "auto" || overflowY === "scroll" || overflow === "auto" || overflow === "scroll") {
        scrollParent.addEventListener("scroll", update);

        break;
      }
      scrollParent = scrollParent.parentElement;
    }
    // Re-run after layout settles (e.g. when activeScreenStream loads content)
    const t1 = setTimeout(update, 50);
    const t2 = setTimeout(update, 200);
    const t3 = setTimeout(update, 500);
    return () => {
      cancelAnimationFrame(id0);
      ro.disconnect();
      window.removeEventListener("resize", update);
      scrollParent?.removeEventListener("scroll", update);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [fullPageWhiteboard, showPip, activeScreenStream]);

  // Preview draw loop when camera on (not recording)
  useEffect(() => {
    if (isRecording || !showPip || avatarImageSrc) return;
    let id: number;
    const loop = () => {
      if (fullPageWhiteboard && !activeScreenStream) drawCameraOverlay();
      else drawCompositeRef.current?.();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [isRecording, showPip, avatarImageSrc, fullPageWhiteboard, activeScreenStream, drawCameraOverlay]);

  // Draw loop for full-page whiteboard
  useEffect(() => {
    if (!fullPageWhiteboard || isRecording) return;
    if (!activeScreenStream && !showPip) return;
    let id: number;
    const loop = () => {
      drawCompositeRef.current?.();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [fullPageWhiteboard, isRecording, activeScreenStream, showPip]);

  // Draw loop for main layout when camera on (screen optional)
  useEffect(() => {
    if (fullPageWhiteboard || isRecording) return;
    if (!showPip || avatarImageSrc) return;
    let id: number;
    const loop = () => {
      drawCompositeRef.current?.();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [fullPageWhiteboard, isRecording, showPip, avatarImageSrc]);

  const previewScreenStreamRef = useRef(previewScreenStream);
  const whiteboardScreenStreamRef = useRef(whiteboardScreenStream);
  const cameraStreamRef = useRef(cameraStream);
  previewScreenStreamRef.current = previewScreenStream;
  whiteboardScreenStreamRef.current = whiteboardScreenStream;
  cameraStreamRef.current = cameraStream;
  useEffect(() => {
    return () => {
      previewScreenStreamRef.current?.getTracks().forEach((t) => t.stop());
      whiteboardScreenStreamRef.current?.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Auto-updater can be added via electron-updater when needed

  // Update favicon (circular PNG) and Tauri window icon to avatar when set
  useEffect(() => {
    const setFavicon = (href: string) => {
      document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]').forEach((el) => el.remove());
      const link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/png";
      link.sizes = "32x32";
      link.href = href;
      document.head.appendChild(link);
      // Force refresh: briefly change title so browser picks up new favicon
      const t = document.title;
      document.title = "";
      requestAnimationFrame(() => { document.title = t; });
    };

    if (avatarImageSrc) {
      Promise.all([
        createCircularIcon(avatarImageSrc, 32),
        createCircularIcon(avatarImageSrc, 128),
      ])
        .then(([fav, icon]) => {
          setFavicon(fav.dataUrl);
          if (isElectron) {
            const api = (window as unknown as { electronAPI?: { setWindowIcon: (b: ArrayBuffer) => Promise<void> } }).electronAPI;
            api?.setWindowIcon?.(icon.arrayBuffer).catch((e: unknown) => console.warn("[DreamWork] setIcon failed:", e));
          }
        })
        .catch((e) => console.warn("[DreamWork] createCircularIcon failed:", e));
    } else {
      createCircularIcon("/logo.png", 32)
        .then((fav) => {
          setFavicon(fav.dataUrl);
        })
        .catch(() => {
          setFavicon("/logo.png");
        });
      if (isElectron) {
        fetch("/logo.png")
          .then((r) => r.arrayBuffer())
          .then((buf) => {
            const api = (window as unknown as { electronAPI?: { setWindowIcon: (b: ArrayBuffer) => Promise<void> } }).electronAPI;
            return api?.setWindowIcon?.(buf);
          })
          .catch(() => {});
      }
    }
  }, [avatarImageSrc, isElectron]);

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    saveSettings({
      glowColor,
      pipPos,
      fullPagePipPos,
      sidebarWidth,
      previewWidth,
      whiteboardHeight,
      avatarSize,
      avatarShape,
      avatarDecor,
      avatarImageSrc: avatarImageSrc ?? undefined,
      beautyMode,
      beautySettings,
      faceFilter,
      recordResolution,
      letterboxBackground,
      letterboxCustomImage: letterboxCustomImage ?? undefined,
      previewPosition,
      fullPagePreviewPos: fullPagePreviewPos ?? undefined,
      micVolume,
      systemVolume,
    });
  }, [
      glowColor,
      pipPos,
      fullPagePipPos,
      sidebarWidth,
      previewWidth,
      whiteboardHeight,
      avatarSize,
      avatarShape,
      avatarDecor,
      avatarImageSrc,
      beautyMode,
      beautySettings,
      faceFilter,
      recordResolution,
      letterboxBackground,
      letterboxCustomImage,
      previewPosition,
      fullPagePreviewPos,
      micVolume,
      systemVolume,
    ]);

  const resetCameraSettings = () => {
    setAvatarSize(120);
    setAvatarShape("circle");
    setAvatarDecor("none");
    setGlowColor("#64c8ff");
    setBeautyMode(false);
    setBeautySettings(presets.natural);
    setFaceFilter("none");
    setMicVolume(100);
    setSystemVolume(80);
    clearAvatarImage();
  };

  const pipPosRef = useRef(pipPos);
  const fullPagePipPosRef = useRef(fullPagePipPos);
  // When recording with screen, refs are source of truth (updated during drag). Don't overwrite with state
  // which may be modified by resize/clamp effects when compact mode applies.
  if (!(isRecording && activeScreenStream)) {
    pipPosRef.current = pipPos;
    fullPagePipPosRef.current = fullPagePipPos;
  }

  // Which camera to move: determined from click target so we anchor the top layer, not the one underneath.
  const previewPageContextRef = useRef(!fullPageWhiteboard);
  useLayoutEffect(() => {
    previewPageContextRef.current = !fullPageWhiteboard;
  }, [fullPageWhiteboard]);

  const setContextFromClick = useCallback((clientX: number, clientY: number) => {
    const sidebarPreview = document.getElementById("dreamwork-preview");
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      if (sidebarPreview?.contains(el)) {
        previewPageContextRef.current = true;
        return;
      }
      if (fullPageContentRef.current?.contains(el)) {
        previewPageContextRef.current = false;
        return;
      }
    }
  }, []);

  const avatarSizeDisplayRef = useRef(avatarSizeDisplay);
  avatarSizeDisplayRef.current = avatarSizeDisplay;

  const handlePipMouseDown = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pipDraggingRef.current) return;
    const pip = pipRef.current;
    const usePreviewPagePos = previewPageContextRef.current;
    const useViewportCoords = !usePreviewPagePos && !!activeScreenStream;
    const container = usePreviewPagePos
      ? previewRef.current
      : (activeScreenStream ? null : fullPageContentRef.current);
    if (!pip) return;
    if (!useViewportCoords && !container) return;
    const pe = e as React.PointerEvent;
    const captureTarget = (pe.pointerId != null && e.currentTarget instanceof HTMLElement) ? e.currentTarget : pip;
    if (pe.pointerId != null && "setPointerCapture" in captureTarget) captureTarget.setPointerCapture(pe.pointerId);
    const posRef = usePreviewPagePos ? pipPosRef : fullPagePipPosRef;
    const setPos = usePreviewPagePos ? setPipPos : setFullPagePipPos;
    const pos = posRef.current;
    const hasOffset = fullPageWhiteboard && activeScreenStream;
    const offsetX = hasOffset ? CAMERA_OFFSET : 0;
    const offsetY = hasOffset ? CAMERA_OFFSET : 0;
    const rect = useViewportCoords
      ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      : container!.getBoundingClientRect();
    pipOffsetRef.current = {
      x: e.clientX - (rect.left + pos.x + offsetX),
      y: e.clientY - (rect.top + pos.y + offsetY),
    };
    pipDraggingRef.current = true;
    setPipDragging(true);
    let rafId: number = 0;
    const onMove = (ev: PointerEvent | MouseEvent) => {
      const r = useViewportCoords
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : container!.getBoundingClientRect();
      const { x: ox, y: oy } = pipOffsetRef.current;
      let x = ev.clientX - r.left - ox;
      let y = ev.clientY - r.top - oy;
      const pipIsPortaled =
        (fullPageWhiteboard && activeScreenStream) ||
        (fullPageWhiteboard && !activeScreenStream && !!portalRect) ||
        (!fullPageWhiteboard && !activeScreenStream && !!mainLayoutPortalRect);
      const useViewport = (!!portalRect || !!mainLayoutPortalRect || useViewportCoords) && pipIsPortaled;
      const px = useViewport ? r.left + x : x;
      const py = useViewport ? r.top + y : y;
      posRef.current = hasOffset ? { x: x - offsetX, y: y - offsetY } : { x, y };
      (pip as HTMLElement).style.left = `${px}px`;
      (pip as HTMLElement).style.top = `${py}px`;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          setPos(posRef.current);
        });
      }
    };
    const cleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      setPos(posRef.current);
      document.removeEventListener("pointermove", onMoveP);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("mousemove", onMoveM);
      document.removeEventListener("mouseup", onUp);
      pipDraggingRef.current = false;
      setPipDragging(false);
    };
    const onUp = cleanup;
    const onMoveP = onMove as (ev: PointerEvent) => void;
    const onMoveM = onMove as (ev: MouseEvent) => void;
    document.addEventListener("pointermove", onMoveP);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("mousemove", onMoveM);
    document.addEventListener("mouseup", onUp);
  }, [portalRect, mainLayoutPortalRect, activeScreenStream, avatarSize, fullPageWhiteboard]);

  const handlePreviewBoxDrag = useCallback((e: React.PointerEvent) => {
    if (!fullPageWhiteboard || !activeScreenStream || previewBoxDraggingRef.current) return;
    const preview = previewRef.current;
    const parent = fullPageContentRef.current;
    if (!preview || !parent) return;
    e.preventDefault();
    e.stopPropagation();
    const parentRect = parent.getBoundingClientRect();
    const previewW = preview.offsetWidth || 320;
    const previewH = preview.offsetHeight || 180;
    const pos = fullPagePreviewPos ?? {
      x: parentRect.width - previewW - 16,
      y: parentRect.height - previewH - 16,
    };
    previewBoxOffsetRef.current = {
      x: e.clientX - (parentRect.left + pos.x),
      y: e.clientY - (parentRect.top + pos.y),
    };
    setFullPagePreviewPos(pos);
    previewBoxDraggingRef.current = true;
    setPreviewBoxDragging(true);
    let lastPos = { x: pos.x, y: pos.y };
    let rafId: number = 0;
    const onMove = (ev: PointerEvent | MouseEvent) => {
      const pr = parent.getBoundingClientRect();
      const { x: ox, y: oy } = previewBoxOffsetRef.current;
      let x = ev.clientX - pr.left - ox;
      let y = ev.clientY - pr.top - oy;
      x = Math.max(0, Math.min(x, pr.width - previewW));
      y = Math.max(0, Math.min(y, pr.height - previewH));
      lastPos = { x, y };
      preview.style.left = `${x}px`;
      preview.style.top = `${y}px`;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          setFullPagePreviewPos(lastPos);
        });
      }
    };
    const cleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener("pointermove", onMove as (ev: PointerEvent) => void);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("mousemove", onMove as (ev: MouseEvent) => void);
      document.removeEventListener("mouseup", onUp);
      previewBoxDraggingRef.current = false;
      setPreviewBoxDragging(false);
      setFullPagePreviewPos(lastPos);
    };
    const onUp = cleanup;
    document.addEventListener("pointermove", onMove as (ev: PointerEvent) => void);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("mousemove", onMove as (ev: MouseEvent) => void);
    document.addEventListener("mouseup", onUp);
  }, [fullPageWhiteboard, activeScreenStream, fullPagePreviewPos]);

  const handlePreviewPointerDown = useCallback((e: React.PointerEvent) => {
    if (!showPip || pipDraggingRef.current) return;
    setContextFromClick(e.clientX, e.clientY);
    const pip = pipRef.current;
    const container = fullPageWhiteboard
      ? (activeScreenStream ? previewRef.current : fullPageContentRef.current)
      : previewRef.current;
    if (!container) return;
    const buffer = 40;
    let inCameraBounds: boolean;
    if (pip) {
      const r = pip.getBoundingClientRect();
      inCameraBounds =
        e.clientX >= r.left - buffer && e.clientX <= r.right + buffer &&
        e.clientY >= r.top - buffer && e.clientY <= r.bottom + buffer;
    } else {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const pos = fullPageWhiteboard ? fullPagePipPosRef.current : pipPosRef.current;
      inCameraBounds =
        x >= pos.x - buffer && x <= pos.x + avatarWidthDisplay + buffer &&
        y >= pos.y - buffer && y <= pos.y + avatarHeightDisplay + buffer;
    }
    // When we have both preview box and camera (fullPage+screen), distinguish: camera vs preview box drag
    if (fullPageWhiteboard && activeScreenStream) {
      if (inCameraBounds) {
        e.preventDefault();
        e.stopPropagation();
        handlePipMouseDown(e as unknown as React.MouseEvent);
      } else {
        handlePreviewBoxDrag(e);
      }
    } else if (!fullPageWhiteboard || inCameraBounds) {
      // Sidebar: any click in preview starts camera drag. FullPage without screen: only when on camera.
      e.preventDefault();
      e.stopPropagation();
      handlePipMouseDown(e as unknown as React.MouseEvent);
    }
  }, [fullPageWhiteboard, activeScreenStream, showPip, avatarWidthDisplay, avatarHeightDisplay, handlePipMouseDown, handlePreviewBoxDrag, setContextFromClick]);

  // Native document capture: any click in preview starts drag (bypasses iframe blocking)
  const handlePipMouseDownRef = useRef(handlePipMouseDown);
  handlePipMouseDownRef.current = handlePipMouseDown;
  const handlePreviewPointerDownRef = useRef(handlePreviewPointerDown);
  handlePreviewPointerDownRef.current = handlePreviewPointerDown;
  useEffect(() => {
    if (!showPip) return;
    const handleNative = (e: PointerEvent | MouseEvent) => {
      if (pipDraggingRef.current || previewBoxDraggingRef.current) return;
      if ((e.target as HTMLElement)?.closest?.('[role="dialog"], [data-modal-overlay]')) return;
      const el = (e.target as Node).nodeType === Node.ELEMENT_NODE ? (e.target as HTMLElement) : (e.target as Node).parentElement;
      if (el?.closest?.('[data-dreamwork-no-intercept]')) return;
      if (el?.closest?.('header, button, a, input, select, [role="button"], aside')) return;
      if (el?.tagName === "IFRAME" || el?.closest?.("iframe")) return;
      // When fullPageWhiteboard without screen: only intercept clicks near the camera pip.
      // Using fullPageContentRef would treat the entire whiteboard as "preview" and block Excalidraw.
      const container = fullPageWhiteboard && !activeScreenStream ? null : previewRef.current;
      let inPreview: boolean;
      if (container) {
        const r = container.getBoundingClientRect();
        inPreview =
          e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inPreview && fullPageWhiteboard && activeScreenStream) {
          const pip = pipRef.current;
          if (pip) {
            const pr = pip.getBoundingClientRect();
            const buf = 40;
            inPreview =
              e.clientX >= pr.left - buf && e.clientX <= pr.right + buf &&
              e.clientY >= pr.top - buf && e.clientY <= pr.bottom + buf;
          }
        }
      } else {
        if (!fullPageWhiteboard) return;
        const pip = pipRef.current;
        if (!pip) return;
        const pr = pip.getBoundingClientRect();
        const buf = 40;
        inPreview =
          e.clientX >= pr.left - buf && e.clientX <= pr.right + buf &&
          e.clientY >= pr.top - buf && e.clientY <= pr.bottom + buf;
      }
      if (!inPreview) return;
      setContextFromClick(e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
      handlePreviewPointerDownRef.current(e as unknown as React.PointerEvent);
    };
    document.addEventListener("pointerdown", handleNative, { capture: true });
    document.addEventListener("mousedown", handleNative, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", handleNative, { capture: true });
      document.removeEventListener("mousedown", handleNative, { capture: true });
    };
  }, [showPip, fullPageWhiteboard, activeScreenStream, setContextFromClick]);

  useEffect(() => {
    if (pipDragging || previewBoxDragging) {
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      return () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }
  }, [pipDragging, previewBoxDragging]);

  useEffect(() => {
    const v = cameraVideoRef.current;
    if (v && cameraStream) {
      v.srcObject = cameraStream;
      v.play().catch(() => {});
    }
    const source = cameraSourceVideoRef.current;
    if (source && cameraStream) {
      source.setAttribute("playsinline", "");
      source.setAttribute("webkit-playsinline", "");
      source.srcObject = cameraStream;
      source.play().catch(() => {});
    } else if (source && !cameraStream) {
      source.srcObject = null;
    }
  }, [cameraStream, fullPageWhiteboard]);

  const applyPreviewPosition = async (pos: typeof previewPosition) => {
    setPreviewPosition(pos);
    if (isRecording) {
      await setCompactMode(pos, 420, 320);
    }
  };

  return (
    <>
      <TeleprompterErrorBoundary
        key={`teleprompter-${showTeleprompter ? "open" : "closed"}-${teleprompterResetSeq}`}
        onCrash={() => {
          setShowTeleprompter(false);
          setTeleprompterPlaying(false);
        }}
      >
        <TeleprompterOverlay
          isVisible={showTeleprompter && !detachedHelpersEnabled}
          script={teleprompterScript}
          isPlaying={teleprompterPlaying}
          speed={teleprompterSpeed}
          fontSize={teleprompterFontSize}
          opacity={teleprompterOpacity}
          overlayWidth={teleprompterWidth}
          nearCamera={teleprompterNearCamera}
          anchorRect={teleprompterAnchorRect}
          position={teleprompterPosition}
          locked={teleprompterLocked}
          resetSignal={teleprompterResetSeq}
          onSetPlaying={setTeleprompterPlaying}
          onPositionChange={setTeleprompterPosition}
          onDragStart={() => setTeleprompterNearCamera(false)}
          onToggleLocked={handleToggleTeleprompterLock}
          onReset={handleResetTeleprompter}
          onHide={() => {
            setShowTeleprompter(false);
            setTeleprompterPlaying(false);
          }}
          onNudgeSpeed={(delta) => setTeleprompterSpeed((prev) => Math.max(10, Math.min(180, prev + delta)))}
        />
        <TeleprompterPanel
          isVisible={showTeleprompter && !detachedHelpersEnabled}
          isPlaying={teleprompterPlaying}
          script={teleprompterScript}
          speed={teleprompterSpeed}
          fontSize={teleprompterFontSize}
          opacity={teleprompterOpacity}
          overlayWidth={teleprompterWidth}
          nearCamera={teleprompterNearCamera}
          locked={teleprompterLocked}
          position={teleprompterPanelPosition}
          onSetScript={setTeleprompterScript}
          onSetPlaying={setTeleprompterPlaying}
          onSetSpeed={setTeleprompterSpeed}
          onSetFontSize={setTeleprompterFontSize}
          onSetOpacity={setTeleprompterOpacity}
          onSetOverlayWidth={setTeleprompterWidth}
          onSetNearCamera={handleSetTeleprompterNearCamera}
          onPositionChange={setTeleprompterPanelPosition}
          onToggleLocked={handleToggleTeleprompterLock}
          onReset={handleResetTeleprompter}
          onHide={() => {
            setShowTeleprompter(false);
            setTeleprompterPlaying(false);
          }}
        />
      </TeleprompterErrorBoundary>
      {showLiveMeetingModal && (
        <LiveMeetingErrorBoundary onClose={() => setShowLiveMeetingModal(false)}>
          <Suspense
            fallback={
              <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/30 backdrop-blur-sm">
                <div className="text-sm text-white/90">Loading meeting...</div>
              </div>
            }
          >
            <LiveMeetingModal
              isOpen={showLiveMeetingModal}
              onClose={() => setShowLiveMeetingModal(false)}
            />
          </Suspense>
        </LiveMeetingErrorBoundary>
      )}
      {/* Persistent screen video: never unmounts so stream survives Whiteboard <-> Preview navigation */}
      <video
        ref={persistentScreenVideoRef}
        autoPlay
        muted
        playsInline
        className="fixed -z-50 size-0 opacity-0 pointer-events-none"
        aria-hidden
      />
      {/* Persistent camera source: keep active during recording to avoid decode drops (readyState=0 flashes). */}
      {showCameraSourceVideo && (
      <video
        ref={cameraSourceVideoRef}
        autoPlay
        muted
        playsInline
        className="fixed pointer-events-none overflow-hidden object-cover"
        style={{
          left: fullPageWhiteboard ? -9999 : cameraViewportPos.x,
          top: fullPageWhiteboard ? -9999 : cameraViewportPos.y,
          width: avatarWidthDisplay,
          height: avatarHeightDisplay,
          zIndex: fullPageWhiteboard ? -1 : 99990,
          transform: "translate3d(0,0,0)",
          borderRadius: avatarShape === "circle" ? "50%" : 8,
          // Keep source for decode; fully hidden during recording to avoid duplicate preview
          opacity: isRecording ? 0 : 0.001,
        }}
        onLoadedMetadata={(e) => {
          setTimeout(() => e.currentTarget.play().catch(() => {}), 50);
        }}
        aria-hidden
      />
      )}
      <div
        className={`glass-bg flex h-screen flex-col ${showOutput && recordedClips.length > 0 ? "overflow-y-auto" : "overflow-hidden"}`}
      >
      <header
        data-dreamwork-no-intercept
        className={`glass-panel sticky top-0 z-50 flex shrink-0 flex-col shadow-sm ${
          isCompact ? "gap-1.5 px-3 py-2" : "gap-2 px-4 py-3"
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-4">
            <div className="flex shrink-0 items-center gap-2">
              <img
                src={avatarImageSrc ?? "/logo.png"}
                alt="DreamWorks"
                className={`shrink-0 rounded-full object-cover ring-2 ring-white/30 ${isCompact ? "size-7" : "size-9"}`}
              />
              <h1 className={`font-semibold tracking-tight truncate ${isCompact ? "text-sm" : "text-base"}`}>
                DreamWorks
              </h1>
            </div>
            <div className="h-6 w-px shrink-0 bg-border/60" />
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
              aria-label="Settings"
            >
              <Settings className="size-5" />
            </button>
            <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
              <div className="flex shrink-0 items-center gap-4 min-w-max">
              <RecordingControls
                hasScreen={hasScreen}
                hasCamera={hasCamera}
                isRecording={isRecording}
                isRecordingPaused={isRecordingPaused}
                compact={isCompact}
                onCaptureScreen={captureScreen}
                onStopScreenShare={stopScreenShare}
                onToggleCamera={showPip ? stopCamera : startCamera}
                onToggleRecord={toggleRecord}
                onPauseRecording={pauseRecording}
                onResumeRecording={resumeRecording}
                onOpenFullPageWhiteboard={closeFullPageWhiteboard}
                onOpenLiveMeeting={() => setShowLiveMeetingModal(true)}
                onToggleTeleprompter={handleToggleTeleprompter}
                showWhiteboard={true}
                showTeleprompter={showTeleprompter}
                recordingTimeLabel={formatRecordingTime(recordingTime)}
              />
              {!isCompact && (
                <>
                  <div className="h-6 w-px shrink-0 bg-border/60" />
                  <div className="sector-card flex items-center gap-2 rounded-lg px-3 py-1.5 text-[8px] font-semibold shrink-0">
                    <span className={hasScreen ? "font-semibold text-emerald-600" : "text-muted-foreground"}>
                      {hasScreen ? "✓" : "1."} Screen
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className={hasCamera ? "font-semibold text-emerald-600" : "text-muted-foreground"}>
                      {hasCamera ? "✓" : "2."} Camera
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className="text-muted-foreground">3. Record</span>
                  </div>
                </>
              )}
              </div>
            </div>
          </div>
        </header>
        {showSettings && (
          <div className="fixed inset-y-0 right-0 z-[100000] w-[320px] border-l border-slate-200 bg-white shadow-xl" data-dreamwork-no-intercept>
            <div className="flex h-full flex-col overflow-y-auto p-4 text-slate-900">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-900">Settings</span>
                <button
                  type="button"
                  onClick={() => setShowSettings(false)}
                  className="rounded p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  ×
                </button>
              </div>
              <SettingsPanel
                avatarSize={avatarSize}
                onAvatarSizeChange={setAvatarSize}
                avatarShape={avatarShape}
                onAvatarShapeChange={setAvatarShape}
                avatarDecor={avatarDecor}
                onAvatarDecorChange={setAvatarDecor}
                glowColor={glowColor}
                onGlowColorChange={setGlowColor}
                avatarImageSrc={avatarImageSrc}
                onUseImage={handleAvatarImage}
                onClearImage={clearAvatarImage}
                beautyMode={beautyMode}
                onBeautyModeChange={setBeautyMode}
                beautySettings={beautySettings}
                onBeautySettingsChange={setBeautySettings}
                faceFilter={faceFilter}
                onFaceFilterChange={setFaceFilter}
                micVolume={micVolume}
                onMicVolumeChange={setMicVolume}
                systemVolume={systemVolume}
                onSystemVolumeChange={setSystemVolume}
                recordResolution={recordResolution}
                onRecordResolutionChange={setRecordResolution}
                letterboxBackground={letterboxBackground}
                onLetterboxBackgroundChange={setLetterboxBackground}
                letterboxCustomImage={letterboxCustomImage}
                onLetterboxCustomImageChange={setLetterboxCustomImage}
              />
            </div>
          </div>
        )}
        <div className="flex flex-1 min-h-0 gap-0">
          <div ref={fullPageContentRef} className="relative flex-1 min-h-0 sector-card overflow-hidden bg-white">
          {/* Composite overlay: behind whiteboard so user can draw. Draw loop updates it for recording. */}
          {showPip && !activeScreenStream && (cameraStream || avatarImageSrc) && (
            <div
              ref={previewRef}
              className={`absolute inset-0 z-[9997] pointer-events-none ${fullPageWhiteboard && !activeScreenStream && !isRecording ? "invisible" : ""}`}
              onPointerDownCapture={handlePreviewPointerDown}
            >
              <canvas
                ref={compositeRef}
                className="absolute inset-0 w-full h-full pointer-events-none"
              />
              {/* Hit target for drag - same size as avatar to avoid visible extra area */}
              <div
                className="absolute z-10 cursor-grab touch-none pointer-events-auto"
                style={{
                  left: Math.max(0, fullPagePipPos.x),
                  top: Math.max(0, fullPagePipPos.y),
                  width: avatarWidthDisplay,
                  height: avatarHeightDisplay,
                  touchAction: "none",
                }}
                onMouseDown={handlePipMouseDown}
                onPointerDown={(e) => handlePipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
                aria-label="Drag to move camera"
              />
            </div>
          )}
            {/* Whiteboard on top so user can draw (brush, etc). Composite behind for recording. */}
            <div className="absolute inset-0 z-[9998]">
              <ExcalidrawBoard onCanvasLayersChange={handleWhiteboardLayersChange} />
            </div>
          {/* Camera: portal to body. When Capture Screen, portal is offset from composite so user can distinguish them. */}
          {showPip && fullPageWhiteboard && (cameraStream || avatarImageSrc) &&
            createPortal(
              <div
                style={{
                  position: "fixed",
                  left: activeScreenStream ? fullPagePipPos.x + CAMERA_OFFSET : (portalRect ? portalRect.left + fullPagePipPos.x : fullPagePipPos.x),
                  top: activeScreenStream ? fullPagePipPos.y + CAMERA_OFFSET : (portalRect ? portalRect.top + fullPagePipPos.y : fullPagePipPos.y),
                  width: avatarWidthDisplay,
                  height: avatarHeightDisplay,
                  zIndex: 99999,
                  overflow: "hidden",
                  borderRadius: avatarShape === "circle" ? "50%" : 8,
                  backgroundColor: "transparent",
                  boxShadow: activeScreenStream ? "0 4px 16px rgba(0,0,0,0.2)" : "none",
                }}
                ref={pipRef}
              >
                {/* Canvas overlay: beauty/filter when outside preview; above CircularWebcam (9999) so effects show */}
                {(cameraOutsidePreview || (!activeScreenStream && !avatarImageSrc) || (faceFilter !== "none" && !avatarImageSrc)) && (
                  <canvas
                    ref={cameraOverlayRef}
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    style={{
                      borderRadius: avatarShape === "circle" ? "50%" : 8,
                      zIndex: 10000,
                    }}
                  />
                )}
                {/* Drag overlay: on top for pointer events */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    cursor: "grab",
                    zIndex: 10001,
                    borderRadius: avatarShape === "circle" ? "50%" : undefined,
                  }}
                  onMouseDown={handlePipMouseDown}
                  onPointerDown={(e) => handlePipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
                  aria-label="Drag to move camera"
                />
                <CircularWebcam
                  hidden={false}
                  forceCanvasDisplay={false}
                  useExternalVideo={false}
                  useCanvasForDisplay={false}
                  useImgForDisplay={false}
                  externalVideoRef={cameraSourceVideoRef}
                  cameraStream={cameraStream}
                  avatarWidth={avatarWidthDisplay}
                  avatarHeight={avatarHeightDisplay}
                  avatarShape={avatarShape}
                  avatarDecor={avatarDecor}
                  glowColor={glowColor}
                  beautyMode={beautyMode}
                  beautyFilter={beautySettingsToFilter(beautySettings)}
                  avatarImageSrc={avatarImageSrc}
                  pipPos={{ x: 0, y: 0 }}
                  onPipMouseDown={handlePipMouseDown}
                  pipRef={portalCameraInnerRef}
                  cameraVideoRef={cameraVideoRef}
                  avatarImgRef={avatarImgRef}
                />
              </div>,
              document.body
            )}
          </div>
          <ResizeHandle
            direction="horizontal"
            onResize={(d) =>
              setPreviewWidth((w) => Math.max(80, Math.min(600, w - d)))
            }
          />
          {/* Preview strip: resizable */}
          <div
            className="flex shrink-0 flex-col border-l border-white/20 bg-slate-900/50 p-2"
            style={{ width: previewWidth }}
          >
            {activeScreenStream ? (
              <div
                ref={previewRef}
                className="relative flex min-h-0 flex-1 overflow-hidden rounded-xl border-2 border-white/30 bg-slate-900"
                onPointerDownCapture={handlePreviewPointerDown}
              >
                <video
                  ref={screenVideoRef}
                  className="block size-full object-contain"
                  autoPlay
                  muted
                  playsInline
                  style={{ visibility: showPip ? "hidden" : "visible" }}
                  onLoadedData={() => drawComposite()}
                />
                <canvas
                  ref={compositeRef}
                  className="absolute inset-0 size-full object-contain pointer-events-none"
                  style={{ visibility: showPip ? "visible" : "hidden" }}
                />
                {showPip && (
                  <div
                    className="absolute z-10 cursor-grab touch-none"
                    style={{
                      left: Math.max(0, pipPos.x),
                      top: Math.max(0, pipPos.y),
                      width: avatarWidthDisplay,
                      height: avatarHeightDisplay,
                      touchAction: "none",
                    }}
                    onMouseDown={handlePipMouseDown}
                    onPointerDown={(e) => handlePipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
                    aria-label="Drag to move camera"
                  />
                )}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/20 text-sm text-muted-foreground">
                Capture screen
              </div>
            )}
          </div>
        </div>
        {showOutput && recordedClips.length > 0 && (
          <>
            <ResizeHandle
              direction="vertical"
              onResize={(d) =>
                setOutputHeight((h) =>
                  Math.max(120, Math.min(Math.round(window.innerHeight * 0.7), h - d))
                )
              }
            />
            <div
              className="glass-panel mx-4 mb-4 flex shrink-0 flex-col gap-4 overflow-auto rounded-xl p-4"
              style={{ height: outputHeight }}
            >
            <div className="grid grid-cols-3 gap-4">
              {recordedClips.map(({ id, blob }) => (
                <ClipPreview
                  key={id}
                  blob={blob}
                  onSave={(b, ext) => downloadRecording(b, ext)}
                  onCopy={() => copyRecording(blob)}
                />
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {recordedClips.length}/3 clips — save before recording again
            </span>
          </div>
          </>
        )}
      </div>
      {false && (
    <div className="glass-bg flex h-screen flex-col overflow-hidden">
      {showUseInPreviewDialog && (
        <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/40 backdrop-blur-sm" data-modal-overlay role="dialog" aria-modal="true">
          <div className="flex flex-col gap-4 rounded-xl border border-black/10 bg-[#fafafa] p-6 shadow-xl">
            <p className="text-sm font-medium text-foreground">Use whiteboard in preview?</p>
            <p className="text-xs text-muted-foreground">
              Yes: overlay on preview for recording. No: keep in sidebar.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-lg border border-black/10 bg-white px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-gray-100"
                onClick={() => handleUseInPreviewChoice(false)}
              >
                No
              </button>
              <button
                type="button"
                className="flex-1 rounded-lg border border-black/10 bg-white px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-gray-100"
                onClick={() => handleUseInPreviewChoice(true)}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
      <header
        data-dreamwork-no-intercept
        className={`glass-panel sticky top-0 z-50 flex shrink-0 flex-col shadow-sm ${
          isCompact ? "gap-1.5 px-3 py-2" : "gap-2 px-4 py-3"
        }`}
      >
        <div className={`flex min-w-0 flex-1 ${isCompact ? "flex-col gap-2" : "items-center gap-4 flex-nowrap overflow-x-auto"}`}>
          <div className="flex shrink-0 items-center gap-2 min-w-0">
              <img
                src={avatarImageSrc ?? "/logo.png"}
                alt="DreamWorks"
              className={`shrink-0 rounded-full object-cover ring-2 ring-white/30 ${isCompact ? "size-7" : "size-9"}`}
            />
              <h1 className={`font-semibold tracking-tight truncate ${isCompact ? "text-sm" : "text-base"}`}>
                DreamWorks
              </h1>
          </div>
          {!isCompact && <div className="h-6 w-px shrink-0 bg-border/60" />}
          <div className={`flex min-w-0 flex-1 items-center ${isCompact ? "justify-start" : "justify-center overflow-x-auto"}`}>
            <RecordingControls
              hasScreen={hasScreen}
              hasCamera={hasCamera}
              isRecording={isRecording}
              isRecordingPaused={isRecordingPaused}
              compact={isCompact}
              onCaptureScreen={captureScreen}
              onStopScreenShare={stopScreenShare}
              onToggleCamera={handleToggleCameraFromControls}
              onToggleRecord={toggleRecord}
              onPauseRecording={pauseRecording}
              onResumeRecording={resumeRecording}
              onOpenFullPageWhiteboard={openFullPageWhiteboard}
              onToggleWhiteboard={() => setShowWhiteboard((v) => !v)}
              onOpenLiveMeeting={() => setShowLiveMeetingModal(true)}
              onToggleTeleprompter={handleToggleTeleprompter}
              onRecoverOverlays={handleRecoverOverlays}
              showWhiteboard={showWhiteboard}
              showTeleprompter={showTeleprompter}
              recordingTimeLabel={formatRecordingTime(recordingTime)}
            />
          </div>
          {!isCompact && (
            <>
            <div className="h-6 w-px shrink-0 bg-border/60" />
            <div className="flex shrink-0 items-center gap-2">
              <div className="sector-card flex items-center gap-2 rounded-lg px-3 py-1.5 text-[8px] font-semibold">
                <span className={hasScreen ? "font-semibold text-emerald-600" : "text-muted-foreground"}>
                  {hasScreen ? "✓" : "1."} Screen
                </span>
                <span className="text-muted-foreground">→</span>
                <span className={hasCamera ? "font-semibold text-emerald-600" : "text-muted-foreground"}>
                  {hasCamera ? "✓" : "2."} Camera
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="text-muted-foreground">3. Record</span>
              </div>
            </div>
            </>
          )}
        </div>
        {isRecording && (
          <div className={`flex flex-wrap items-center gap-2 ${isCompact ? "gap-1.5" : ""}`}>
            <div
              className={`flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-500/20 font-mono tabular-nums backdrop-blur-md ${
                isCompact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
              }`}
            >
              <span className={`rounded-full ${isCompact ? "h-1.5 w-1.5" : "h-2 w-2"} ${isRecordingPaused ? "bg-amber-500" : "animate-pulse bg-red-500"}`} />
              <span>{formatRecordingTime(recordingTime)}</span>
              <span className="font-medium text-red-600">
                {isRecordingPaused ? "⏸" : "● LIVE"}
              </span>
            </div>
            <div className="flex gap-1">
              {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((pos) => (
                <GlassButton
                  key={pos}
                  variant={previewPosition === pos ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => applyPreviewPosition(pos)}
                >
                  {pos === "top-left" ? "↖" : pos === "top-right" ? "↗" : pos === "bottom-left" ? "↙" : "↘"}
                </GlassButton>
              ))}
            </div>
          </div>
        )}
      </header>

      <div className={`flex flex-1 min-h-0 ${isRecording && isElectron && !keepFullStudioWhileRecording ? "flex-col" : ""}`}>
        <main
          className="flex min-w-0 flex-1 flex-col min-h-0 overflow-auto p-4"
          style={{ minWidth: 200 }}
        >
          <div id="dreamwork-preview" className="sector-card flex flex-1 flex-col overflow-hidden p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Preview
              </span>
            </div>
            <div
              ref={previewRef}
              className={`relative w-full overflow-hidden rounded-xl border border-border/80 shadow-lg aspect-video max-h-[calc(100vh-14rem)] ${activeScreenStream || showPip ? "bg-slate-900" : "bg-slate-800"}`}
              onPointerDownCapture={handlePreviewPointerDown}
            >
            {captureError && !activeScreenStream && (
              <div className="glass-panel absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 p-6">
                <span className="text-center text-sm">{captureError}</span>
                <span className="text-center text-xs text-muted-foreground">
                  In the picker, use the &quot;Window&quot; tab to capture a specific app. Grant Screen Recording in
                  System Settings if needed.
                </span>
                <button
                  type="button"
                  className="glass-panel rounded-lg border-white/20 bg-white/20 px-4 py-2 text-sm font-medium backdrop-blur-md hover:bg-white/30"
                  onClick={captureScreen}
                >
                  Try again
                </button>
              </div>
            )}
            {!activeScreenStream && !captureError && !showPip && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Capture screen to start
              </div>
            )}
            <div
              className="pointer-events-none absolute inset-0"
              style={{ zIndex: showPip ? 25 : undefined }}
            >
              <video
                ref={screenVideoRef}
                className="block size-full object-contain"
                autoPlay
                muted
                playsInline
                style={{
                  display: activeScreenStream ? "block" : "none",
                  visibility: showPip ? "hidden" : "visible",
                }}
                onLoadedData={() => drawComposite()}
              />
              <canvas
                ref={compositeRef}
                id="composite"
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                style={{ display: activeScreenStream ? "block" : "none", zIndex: 1 }}
              />
              {showPip && activeScreenStream && !fullPageWhiteboard && (
                <div
                  ref={pipRef}
                  className={`absolute z-10 cursor-grab touch-none pointer-events-auto shadow-lg ${avatarShape === "circle" ? "rounded-full" : "rounded-lg"}`}
                  style={{
                    left: pipPos.x,
                    top: pipPos.y,
                    width: avatarWidthDisplay,
                    height: avatarHeightDisplay,
                  }}
                  onMouseDown={handlePipMouseDown}
                  onPointerDown={(e) => handlePipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
                  aria-label="Drag to move camera"
                >
                  <CircularWebcam
                    hidden={captureWebcamHidden}
                    useCanvasForDisplay={false}
                    useImgForDisplay={false}
                    externalVideoRef={cameraSourceVideoRef}
                    cameraStream={cameraStream}
                  avatarWidth={avatarWidthDisplay}
                  avatarHeight={avatarHeightDisplay}
                    avatarShape={avatarShape}
                    avatarDecor={avatarDecor}
                    glowColor={glowColor}
                    beautyMode={beautyMode}
                    beautyFilter={beautySettingsToFilter(beautySettings)}
                    avatarImageSrc={avatarImageSrc}
                    pipPos={{ x: 0, y: 0 }}
                    onPipMouseDown={handlePipMouseDown}
                    pipRef={portalCameraInnerRef}
                    cameraVideoRef={cameraVideoRef}
                    avatarImgRef={avatarImgRef}
                  />
                </div>
              )}
            </div>
            {showWhiteboard && whiteboardInPreview && (
              <div className="absolute inset-0 z-20 rounded-xl overflow-hidden bg-white">
                <ExcalidrawBoard onCanvasLayersChange={handleWhiteboardLayersChange} />
              </div>
            )}
            {showPip && !activeScreenStream && mainLayoutPortalRect &&
              createPortal(
                <div
                  style={{
                    position: "fixed",
                    left: mainLayoutPortalRect!.left + pipPos.x,
                    top: mainLayoutPortalRect!.top + pipPos.y,
                    width: avatarWidthDisplay,
                    height: avatarHeightDisplay,
                    zIndex: 99999,
                    cursor: "grab",
                    touchAction: "none",
                  }}
                  ref={pipRef}
                  onMouseDown={handlePipMouseDown}
                  onPointerDown={(e) => handlePipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
                  aria-label="Drag to move camera"
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: avatarWidthDisplay,
                      height: avatarHeightDisplay,
                      borderRadius: avatarShape === "circle" ? "50%" : undefined,
                    }}
                  >
                    {(faceFilter !== "none" && !avatarImageSrc) && (
                      <canvas
                        ref={cameraOverlayRef}
                        className="absolute inset-0 w-full h-full pointer-events-none"
                        style={{
                          borderRadius: avatarShape === "circle" ? "50%" : 8,
                          zIndex: 10000,
                        }}
                      />
                    )}
                    <CircularWebcam
                    hidden={false}
                    useCanvasForDisplay={false}
                    useImgForDisplay={false}
                    externalVideoRef={cameraSourceVideoRef}
                    cameraStream={cameraStream}
                  avatarWidth={avatarWidthDisplay}
                  avatarHeight={avatarHeightDisplay}
                    avatarShape={avatarShape}
                    avatarDecor={avatarDecor}
                    glowColor={glowColor}
                    beautyMode={beautyMode}
                    beautyFilter={beautySettingsToFilter(beautySettings)}
                    avatarImageSrc={avatarImageSrc}
                    pipPos={{ x: 0, y: 0 }}
                    onPipMouseDown={handlePipMouseDown}
                    pipRef={portalCameraInnerRef}
                    cameraVideoRef={cameraVideoRef}
                    avatarImgRef={avatarImgRef}
                  />
                </div>
                </div>,
                document.body
              )}
            {showPip && !activeScreenStream && !mainLayoutPortalRect && (
              <div
                style={{
                  position: "absolute",
                  left: pipPos.x,
                  top: pipPos.y,
                  width: avatarWidthDisplay,
                  height: avatarHeightDisplay,
                  zIndex: 9999,
                }}
              >
                <CircularWebcam
                  hidden={false}
                  useCanvasForDisplay={false}
                  useImgForDisplay={false}
                  externalVideoRef={cameraSourceVideoRef}
                  cameraStream={cameraStream}
                  avatarWidth={avatarWidthDisplay}
                  avatarHeight={avatarHeightDisplay}
                  avatarShape={avatarShape}
                  avatarDecor={avatarDecor}
                  glowColor={glowColor}
                  beautyMode={beautyMode}
                  beautyFilter={beautySettingsToFilter(beautySettings)}
                  avatarImageSrc={avatarImageSrc}
                  pipPos={{ x: 0, y: 0 }}
                  onPipMouseDown={handlePipMouseDown}
                  pipRef={pipRef}
                  cameraVideoRef={cameraVideoRef}
                  avatarImgRef={avatarImgRef}
                />
              </div>
            )}
            </div>

            {showOutput && recordedClips.length > 0 && (
            <div className="glass-panel mt-4 flex flex-col gap-4 rounded-xl p-4">
              <div className="grid grid-cols-3 gap-4">
                {recordedClips.map(({ id, blob }) => (
                  <ClipPreview
                    key={id}
                    blob={blob}
                    onSave={(b, ext) => downloadRecording(b, ext)}
                    onCopy={() => copyRecording(blob)}
                  />
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {recordedClips.length}/3 clips — save before recording again
              </span>
            </div>
            )}
          </div>
        </main>

        {(!isRecording || !isElectron) && (
          <>
            <ResizeHandle
              direction="horizontal"
              onResize={(d) =>
                setSidebarWidth((w) => Math.max(240, Math.min(600, w - d)))
              }
            />
            <aside
              data-sidebar
              className="flex min-h-0 shrink-0 flex-col overflow-hidden"
              style={{ width: sidebarWidth }}
            >
          <Sidebar
            showWhiteboard={showWhiteboard}
            whiteboardInPreview={whiteboardInPreview}
            whiteboardHeight={whiteboardHeight}
            onWhiteboardHeightChange={setWhiteboardHeight}
            onOpenWhiteboardRequest={handleOpenWhiteboardRequest}
            onCloseWhiteboard={handleCloseWhiteboard}
            onMoveWhiteboardToSidebar={() => setWhiteboardInPreview(false)}
            onToggleWhiteboard={() => setShowWhiteboard((v) => !v)}
            onScrollToPreview={() => {
              document.getElementById("dreamwork-preview")?.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
              });
            }}
            showPip={showPip}
            avatarSize={avatarSize}
            onAvatarSizeChange={setAvatarSize}
            avatarShape={avatarShape}
            onAvatarShapeChange={setAvatarShape}
            avatarDecor={avatarDecor}
            onAvatarDecorChange={setAvatarDecor}
            glowColor={glowColor}
            onGlowColorChange={setGlowColor}
            avatarImageSrc={avatarImageSrc}
            onUseImage={handleAvatarImage}
            onClearImage={clearAvatarImage}
            beautyMode={beautyMode}
            onBeautyModeChange={setBeautyMode}
            beautySettings={beautySettings}
            onBeautySettingsChange={setBeautySettings}
            faceFilter={faceFilter}
            onFaceFilterChange={setFaceFilter}
            micVolume={micVolume}
            onMicVolumeChange={setMicVolume}
            systemVolume={systemVolume}
            onSystemVolumeChange={setSystemVolume}
            recordResolution={recordResolution}
            onRecordResolutionChange={setRecordResolution}
            letterboxBackground={letterboxBackground}
            onLetterboxBackgroundChange={setLetterboxBackground}
            letterboxCustomImage={letterboxCustomImage}
            onLetterboxCustomImageChange={setLetterboxCustomImage}
            onResetSettings={resetCameraSettings}
          />
            </aside>
          </>
        )}
      </div>
    </div>
      )}
    </>
  );
}
