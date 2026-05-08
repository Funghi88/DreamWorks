import {
  Component,
  lazy,
  Suspense,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  startTransition,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { RecordingControls } from "@/components/RecordingControls";
import { TeleprompterOverlay, TeleprompterPanel } from "@/components/Teleprompter";
import { useWindowSize, useWindowLiveResize } from "@/hooks/useWindowSize";
import type { TeleprompterVoskLang } from "@/hooks/useVoskTeleprompterFollow";
import { CircularWebcam } from "@/components/CircularWebcam";
import { SettingsFloatingPanel } from "@/components/SettingsFloatingPanel";
import { ExcalidrawBoard } from "@/components/ExcalidrawBoard";
import { exportToCanvas, getSceneVersion } from "@excalidraw/excalidraw";
import type { AvatarDecor, AvatarShape } from "@/components/SettingsPanel";
import { beautySettingsToFilter, presets } from "@/lib/beautyEffects";
import { drawEditingTextOverlaySync, drawStandaloneEditingTextOverlay } from "@/lib/excalidrawViewportTextOverlay";
import {
  loadSettings,
  loadSettingsAsync,
  saveSettings,
  getTeleprompterScripts,
  saveTeleprompterScripts,
  hydratePersistedSettingsSnapshot,
  getSettingsMergeBase,
  type RecordResolution,
  type RecordOutputShape,
  isLandscapeRecordOutputShape,
  isPortraitRecordOutputShape,
  type LetterboxBackground,
  type LetterboxMode,
  type TeleprompterScript,
} from "@/lib/storage";
import { captureFrame, getCaptureFilename, scaleTo2KAndBlob, type CapturePresetId, type CaptureModeId } from "@/lib/capture";
import {
  drawFaceFilter,
  normalizeFaceFilterFromStorage,
  type FaceFilterType,
} from "@/lib/faceFilters";
import { useFaceLandmarksWorker } from "@/hooks/useFaceLandmarksWorker";
import {
  snapCameraKitEnvConfigured,
  getSnapCameraKitConfig,
  type PipEffectBackend,
} from "@/config/featureFlags";
import { SnapPipLens } from "@/components/SnapPipLens";
import { createCircularIcon } from "@/lib/circularIcon";
import { defaultSettingsPanelGeom, clampSettingsPanelGeom, type SettingsPanelGeom } from "@/lib/settingsPanelGeom";
import { effectiveShareFillPercent } from "@/lib/recordLayout";
import {
  fitRectWithAspectInside,
  getRecordOutputDimensions,
} from "@/lib/outputAspect";
import {
  computeWhiteboardRecordingSurfacePx,
  wbPipMapDimsFromPreviewEl,
  wbRecordPipOutputRect,
} from "@/lib/wbRecordingLayoutPreview";
import {
  trimMacOSScreenSharePadding,
  snapScreenTrimRect,
  mergeStableScreenTrim,
  resetScreenShareTrimState,
  SCREEN_TRIM_REFRESH_FRAMES,
  shouldSkipMacOSPaddingTrimForDisplaySurface,
  type ScreenTrimRect,
} from "@/lib/screenShareTrim";
import { normalizeTeleprompterImportedText } from "@/lib/teleprompterImport";
import { isDisplayMediaUserCancellation } from "@/lib/userMediaError";
import { getDisplayMediaForScreenCapture } from "@/lib/displayMedia";
import { Settings } from "lucide-react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { setBackgroundThrottling, setNormalMode } from "@/lib/windowUtils";
import { ResizeHandle } from "@/components/ResizeHandle";
import { SplitAffordanceHint } from "@/components/SplitAffordanceHint";
import { WbRecordLayoutMinimapPanel } from "@/components/WbRecordLayoutMinimapPanel";

const LiveMeetingModal = lazy(() =>
  import("@/components/LiveMeeting/LiveMeetingModal").then((m) => ({ default: m.LiveMeetingModal }))
);
import type { LiveMeetingModalHandle } from "@/components/LiveMeeting/LiveMeetingModal";

const RECORD_BITRATES: Record<RecordResolution, number> = {
  "1080p": 10_000_000,
  "2K": 18_000_000,
  "4K": 28_000_000,
};

/** Side strip (shared: left whiteboard / wb-only: right capture) — never narrower than this. */
const SPLIT_STRIP_MIN_PX = 40;
/** Capture / whiteboard column below this width: Drag-only affordance (see SplitAffordanceHint). */
const SPLIT_COLUMN_MIN_USABLE_PX = 320;
/** Default width of the narrow capture column after promoting whiteboard (no stream squeeze). */
const WB_MAIN_DEFAULT_CAPTURE_STRIP_PX = 280;
/** Strip shrink before swapping main column — slower ease-in-out feels more like a scroll / book opening. */
const WB_PROMOTE_STRIP_MS = 780;
const SPLIT_HANDLE_TRACK = "minmax(14px,14px)";
/** Capture preview: drag this corner to adjust Share % (live + recording). */
const SHARE_OVERLAY_CORNER_RESIZE_PX = 22;
const SHARE_OVERLAY_CORNER_HANDLE_PX = 14;
type ShareResizeCorner = "nw" | "ne" | "sw" | "se";
/** Whiteboard recording: PiP bottom-right resize handle (CSS px). */
const PIP_BR_RESIZE_HANDLE_PX = 18;

/**
 * Tri-pane grid: **which column is main (1fr)** is `isScreenShareLayout` (`hasScreen`) — not decided by drag.
 * **stripPx** is only the **narrow column width** (drag handle); main column takes the rest. Min SPLIT_STRIP_MIN_PX.
 */
function splitGridTemplate(stripPx: number, isScreenShareLayout: boolean): string {
  const px = Math.max(SPLIT_STRIP_MIN_PX, Math.round(Number.isFinite(stripPx) ? stripPx : SPLIT_STRIP_MIN_PX));
  const stripTrack = `minmax(${px}px,${px}px)`;
  const wbMainFirst = `minmax(${SPLIT_STRIP_MIN_PX}px, 1fr)`;
  return isScreenShareLayout
    ? `${px}px ${SPLIT_HANDLE_TRACK} minmax(0,1fr)`
    : `${wbMainFirst} ${SPLIT_HANDLE_TRACK} ${stripTrack}`;
}
/** Stop sharing: fade capture first, then clear stream + subtle whiteboard “land” (see index.css). */
const SCREEN_SHARE_EXIT_MS = 400;
const SCREEN_SHARE_RESTORE_MS = 460;
/** Capture/recording banner: readable time, then exit animation (see `CAPTURE_ERROR_EXIT_MS` in class). */
const CAPTURE_ERROR_VISIBLE_MS = 5000;
/** Exit animation length; keep in sync with banner `duration-[420ms]` in JSX. */
const CAPTURE_ERROR_EXIT_MS = 420;
function requestCanvasCaptureFrame(track: MediaStreamTrack | null) {
  if (!track) return;
  (track as MediaStreamTrack & { requestFrame?: () => void }).requestFrame?.();
}

/** Opt-in diagnostics for Capture Screen recording (white video / decode). Set `localStorage.dreamwork_capture_debug = '1'`, reopen devtools, reproduce once, then remove the key. No effect on recording behavior. */
function isDreamworkCaptureDebugEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("dreamwork_capture_debug") === "1";
  } catch {
    return false;
  }
}

/** Flex/grid can flip `getBoundingClientRect` / client size by 1–3px between frames; snap to 4px grid before hysteresis. */
function quantizeCapturePanePx(n: number): number {
  return Math.max(1, Math.round(n / 4) * 4);
}

/** Min delta (px) to accept a new capture-pane size — avoids resetting composite bitmap/CSS every rAF (visible shake, menu-bar capture icon flutter). */
const SCREEN_SHARE_PANE_DEADBAND_PX = 12;
/** Chromium sometimes reports ±2–6px `videoWidth`/`videoHeight` between frames on window capture → contain math jitters; lock until real resize. */
const SCREEN_SHARE_INTRINSIC_JITTER_EPS_PX = 8;
/** Live preview: ignore subpixel movement in computed dest rect (pairs with intrinsic lock). */
const SCREEN_SHARE_DEST_JITTER_EPS_PX = 8;

/**
 * Face landmarks + PiP overlay must sample the same decoded camera as the user sees.
 * Off-screen `cameraSourceVideo` (opacity 0, negative position) often does not advance frames on Electron;
 * prefer portal `cameraVideoRef` when it has real dimensions.
 */
function pickDecodedCameraVideo(
  portalCam: HTMLVideoElement | null,
  offscreenCam: HTMLVideoElement | null
): HTMLVideoElement | null {
  const decoded = (v: HTMLVideoElement | null) =>
    v && v.readyState >= 2 && v.videoWidth > 0 ? v : null;
  /** Electron: visible PiP may decode; off-screen source often stays HAVE_METADATA but is still drawable. */
  const metadataOk = (v: HTMLVideoElement | null) =>
    v && v.srcObject && v.readyState >= 1 && v.videoWidth > 0 ? v : null;
  // Prefer portal before decoded(offscreen): same stream, but off-DOM + opacity 0 often yields blank
  // createImageBitmap frames on Electron while the visible PiP video already has metadata.
  return (
    decoded(portalCam) ??
    metadataOk(portalCam) ??
    decoded(offscreenCam) ??
    metadataOk(offscreenCam) ??
    portalCam ??
    offscreenCam
  );
}

/** PiP overlay + face filters: align with composite camPickRecording — don't require HAVE_CURRENT_DATA. */
function cameraVideoReadableForPipEffects(video: HTMLVideoElement | null): boolean {
  return !!(video?.srcObject && video.videoWidth > 0 && video.readyState >= 1);
}
const TELEPROMPTER_HELPER_URL = "/teleprompter-helper.html";
const MONITOR_HELPER_URL = "/recording-monitor.html";
const TELEPROMPTER_CHANNEL = "dreamwork-teleprompter";
/** Offset between composite (recorded) and portal (draggable) camera in Capture Screen mode */
const CAMERA_OFFSET = 36;
/** Corner radius for rect/portrait avatar - must match rounded-2xl (16px) everywhere */
const AVATAR_RECT_RADIUS = 16;
/** Share Window (= scaled screen share, targetW wide): border/corner in **output** px (1080p → 3px line, 20px radius) */
const SHARE_WINDOW_BORDER_OUT_PX = 3;
const SHARE_WINDOW_CORNER_RADIUS_OUT_PX = 20;
/**
 * Offscreen camera decode box: **square** + contain avoids a 4:3 CSS box stretching perception with
 * widescreen / Presenter Overlay tracks; draw paths use intrinsic `videoWidth`/`videoHeight`.
 */
const CAMERA_SOURCE_VIDEO_BOX_PX = 480;
/** Widescreen / Presenter-style frames: use `contain` in PiP so the speaker is not over-cropped vs `cover`. */
const PIP_VIDEO_CONTAIN_MIN_ASPECT = 1.42;

function pipScaleForVideo(pw: number, ph: number, vw: number, vh: number) {
  const safeW = Math.max(1, vw);
  const safeH = Math.max(1, vh);
  const ar = safeW / safeH;
  const useContain = ar >= PIP_VIDEO_CONTAIN_MIN_ASPECT;
  const s = useContain ? Math.min(pw / safeW, ph / safeH) : Math.max(pw / safeW, ph / safeH);
  const drawW = safeW * s;
  const drawH = safeH * s;
  const dx = (pw - drawW) / 2;
  const dy = (ph - drawH) / 2;
  return { drawW, drawH, dx, dy };
}
/** PiP portal vs Settings: backdrop < camera (sharp preview) < drawer */
const Z_PIP_PORTAL = 99_999;
const Z_PIP_PORTAL_SETTINGS = 1_000_000;
/** Floating settings (above PiP when open; no backdrop). */
const Z_SETTINGS_PANEL = "z-[1000025]";

function drawLetterboxBg(
  ctx: CanvasRenderingContext2D,
  bg: LetterboxBackground,
  w: number,
  h: number,
  customImg: HTMLImageElement | null,
  customMode: LetterboxMode
) {
  if (bg === "custom" && customImg?.complete) {
    const nw = customImg.naturalWidth;
    const nh = customImg.naturalHeight;
    if (customMode === "fill") {
      ctx.drawImage(customImg, 0, 0, w, h);
      return;
    }
    const scale =
      customMode === "fit" ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
    const iw = nw * scale;
    const ih = nh * scale;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
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

/**
 * Composite Excalidraw's stacked canvases (what you see on screen), including zoom/pan.
 * exportToCanvas always fits the full scene bbox — it does not follow the live viewport.
 */
function compositeExcalidrawViewportCanvases(
  container: HTMLElement,
  cssWidth: number,
  cssHeight: number,
  reuseCanvas?: HTMLCanvasElement | null
): HTMLCanvasElement | null {
  const root =
    (container.querySelector(".excalidraw") as HTMLElement | null) ??
    (container.querySelector(".excalidraw-wrapper") as HTMLElement | null) ??
    container;
  const canvases = Array.from(root.querySelectorAll("canvas")).filter((c): c is HTMLCanvasElement => {
    if (!(c instanceof HTMLCanvasElement) || c.width <= 0 || c.height <= 0) return false;
    const s = getComputedStyle(c);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const br = c.getBoundingClientRect();
    const minSide = Math.max(80, Math.min(cssWidth, cssHeight) * 0.35);
    if (br.width < minSide || br.height < minSide) return false;
    return true;
  });
  if (canvases.length === 0) return null;

  const sorted = [...canvases].sort((a, b) => {
    const za = Number.parseInt(getComputedStyle(a).zIndex || "0", 10);
    const zb = Number.parseInt(getComputedStyle(b).zIndex || "0", 10);
    const na = Number.isFinite(za) ? za : 0;
    const nb = Number.isFinite(zb) ? zb : 0;
    return na - nb;
  });

  const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const pw = Math.max(1, Math.round(cssWidth * dpr));
  const ph = Math.max(1, Math.round(cssHeight * dpr));
  const out = reuseCanvas ?? document.createElement("canvas");
  if (out.width !== pw) out.width = pw;
  if (out.height !== ph) out.height = ph;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  if (reuseCanvas) ctx.clearRect(0, 0, pw, ph);

  let drewAny = false;
  for (const c of sorted) {
    try {
      ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, pw, ph);
      drewAny = true;
    } catch {
      /* skip tainted layer; continue so text/other layers still export */
    }
  }
  return drewAny ? out : null;
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
  const [playError, setPlayError] = useState<string | null>(null);
  useEffect(() => {
    setPlayError(null);
    try {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    } catch {
      setPlayError("Failed to load video");
      return () => {};
    }
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
      <div className="aspect-video min-w-0 overflow-hidden rounded-2xl bg-white">
        {playError ? (
          <div className="flex aspect-video items-center justify-center rounded-2xl bg-slate-800 text-sm text-red-400">
            {playError}
          </div>
        ) : (
          url && (
            <video
              src={url}
              controls
              preload="metadata"
              playsInline
              className="aspect-video h-full w-full object-contain"
              onContextMenu={(e) => e.preventDefault()}
              onError={() => setPlayError("Video playback failed")}
            />
          )
        )}
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
  // Removed persistent screen video element (see note near render): dual-decoding caused jitter on macOS.
  const cameraSourceVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const compositeRef = useRef<HTMLCanvasElement>(null);
  const recordingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** PiP overlaps Capture column in viewport — recording may still miss canvas-space intersects; use as fallback to draw PiP into export. */
  const capturePipInColumnRef = useRef(false);
  /** When true, recording must composite PiP even if omitPipFromRecording was on (set at record start from showPip). */
  const recordingSessionIncludePipRef = useRef(false);
  const pipRef = useRef<HTMLDivElement>(null);
  /** WB-only record: invisible preview-hit PiP rects — direct left/top during minimap PiP drag (no setState per move). */
  const wbPreviewPipHitRef = useRef<HTMLDivElement | null>(null);
  const wbPreviewPipBrHitRef = useRef<HTMLDivElement | null>(null);
  /** Full-page Capture: hide webcam/snap subtree while PiP is in the composite (no double-draw); keep portal root opaque for reliable hit-testing. */
  const pipPortalVisualRef = useRef<HTMLDivElement>(null);
  const portalCameraInnerRef = useRef<HTMLDivElement>(null);
  const avatarImgRef = useRef<HTMLImageElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const screenMiniStripRef = useRef<HTMLDivElement>(null);
  const fullPageContentRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  /** Whiteboard-only record: intrinsic board px forRecording layout minimap (updated in drawComposite). */
  const wbRecordingIwihRef = useRef({ iw: 1920, ih: 1080 });
  /** [Whiteboard | handle | Capture] — CSS Grid tri-pane; track widths are authoritative (not flex). */
  const splitTriPaneRef = useRef<HTMLDivElement>(null);
  /** Skip ResizeObserver no-op frames (same width) to avoid redundant split clamp + CSS var churn. */
  const contentAreaWidthRoRef = useRef(0);
  const contentAreaPrevRectRef = useRef<{ w: number; h: number } | null>(null);
  const whiteboardCanvasLayersRef = useRef<HTMLCanvasElement[]>([]);
  const whiteboardExportedRef = useRef<HTMLCanvasElement | null>(null);
  const wbViewportReuseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const wbLiveCompositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const excalidrawAPIRef = useRef<{
    getSceneElements: () => readonly unknown[];
    getAppState: () => Record<string, unknown>;
    getFiles: () => Record<string, unknown>;
  } | null>(null);
  const whiteboardTextureRef = useRef<string | null>(null);
  const whiteboardTextureImgRef = useRef<HTMLImageElement | null>(null);
  const lastCameraFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [portalRect, setPortalRect] = useState<DOMRect | null>(null);
  /** Latest capture-column rect (always updated in layout observer); avoids stale state + reduces setState when unchanged. */
  const portalRectLiveRef = useRef<DOMRect | null>(null);
  /** WB-only portal anchor fallback: keep last good preview rect, never drop to viewport (0,0) during transient null refs. */
  const wbPipPortalLastRectRef = useRef<DOMRect | null>(null);
  const lastPortalRectKeyRef = useRef<string | null>(null);
  /** Capture Screen + recording: PiP visibility toggled via pipRef.style (no setState — avoids React re-renders every frame). */
  /** Schmitt: once PiP is composited into the record canvas, keep until clearly outside (reduces portal opacity blink at the edge). */
  const screenRecPipCompositeStickyRef = useRef(false);
  /** Capture Screen: hysteresis for “outside vs inside” so beauty overlay canvas doesn’t mount/unmount at the column edge (blink). */
  const [pipPortalOverlayOutsideUi, setPipPortalOverlayOutsideUi] = useState(false);
  const [mainLayoutPortalRect, setMainLayoutPortalRect] = useState<DOMRect | null>(null);

  const [previewScreenStream, setPreviewScreenStream] = useState<MediaStream | null>(null);
  const [whiteboardScreenStream, setWhiteboardScreenStream] = useState<MediaStream | null>(null);
  /** Read in async settings merge — must not overwrite strip width after Capture Screen is already live. */
  const previewScreenStreamRef = useRef<MediaStream | null>(null);
  const whiteboardScreenStreamRef = useRef<MediaStream | null>(null);
  previewScreenStreamRef.current = previewScreenStream;
  whiteboardScreenStreamRef.current = whiteboardScreenStream;
  /** Tri-pane + split drag: mirrors capture-main layout (`hasScreen` or squeeze mode below). */
  const hasScreenLayoutRef = useRef(false);
  /** No stream, but wb-main column squeezed to min — use capture-main template so right column is 1fr (not whiteboard). */
  const [captureMainNoStream, setCaptureMainNoStream] = useState(false);
  const captureMainNoStreamRef = useRef(false);
  captureMainNoStreamRef.current = captureMainNoStream;
  /** Screen share active: user promoted whiteboard via header — WB is 1fr, capture is the narrow strip (right). */
  const [preferWhiteboardMain, setPreferWhiteboardMain] = useState(false);
  const preferWhiteboardMainRef = useRef(false);
  preferWhiteboardMainRef.current = preferWhiteboardMain;
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
  const [faceFilter, setFaceFilter] = useState<FaceFilterType>(() =>
    normalizeFaceFilterFromStorage(loadSettings().faceFilter)
  );
  const [pipEffectBackend, setPipEffectBackend] = useState<PipEffectBackend>(() => {
    const raw = loadSettings().pipEffectBackend;
    if (raw === "snap" && snapCameraKitEnvConfigured()) return "snap";
    return "mediapipe";
  });
  const snapLiveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const onSnapLiveCanvas = useCallback((c: HTMLCanvasElement | null) => {
    snapLiveCanvasRef.current = c;
  }, []);
  const faceLandmarksRef = useRef<import("@mediapipe/tasks-vision").NormalizedLandmark[] | null>(null);
  const lastValidLandmarksRef = useRef<import("@mediapipe/tasks-vision").NormalizedLandmark[] | null>(null);
  const lastValidLandmarksAtRef = useRef<number>(0);
  const LANDMARK_PERSIST_MS = 120;
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
  /** Narrow strip width (px); left strip when sharing, right strip when not — adjusted via resize handle. */
  const [whiteboardPanelWidth, setWhiteboardPanelWidth] = useState(
    () => loadSettings().whiteboardPanelWidth ?? SPLIT_STRIP_MIN_PX
  );
  const whiteboardPanelWidthRef = useRef(whiteboardPanelWidth);
  /** True while dragging the whiteboard/capture split (don’t overwrite ref from state). */
  const splitPanelDragActiveRef = useRef(false);
  const splitDragSessionRef = useRef(false);
  /** First pointer X + strip width at drag start — absolute mapping avoids incremental jank. */
  const splitClientXDragRef = useRef<{ startX: number; startW: number } | null>(null);
  if (!splitPanelDragActiveRef.current) {
    whiteboardPanelWidthRef.current = whiteboardPanelWidth;
  }
  /** Measured from content area RO — avoids ref-read-during-render (0 width) so split affordance hints stay correct. */
  const [contentAreaSplitWidth, setContentAreaSplitWidth] = useState(0);
  /**
   * During split-drag (or strip animation), grid is updated via inline styles but React did not re-render;
   * affordances used stale widths. One rAF-batched snapshot per frame keeps Drag vs Capture/WB CTAs in sync.
   */
  const [splitAffordanceLive, setSplitAffordanceLive] = useState<{ strip: number; content: number } | null>(
    null
  );
  const splitAffordanceLiveRafRef = useRef<number | null>(null);
  const splitAffordancePendingRef = useRef<{ strip: number; content: number } | null>(null);
  /** `exiting`: stream still on, capture panel fades; `restoring`: stream off, whiteboard plays settle animation. */
  const [screenShareStopPhase, setScreenShareStopPhase] = useState<"idle" | "exiting" | "restoring">("idle");
  const screenShareExitTimerRef = useRef<number | null>(null);
  const screenShareRestoreTimerRef = useRef<number | null>(null);
  const [outputHeight, setOutputHeight] = useState(240);
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const outputIdleTimerRef = useRef<number | null>(null);
  const outputHoverExpandTimerRef = useRef<number | null>(null);
  const OUTPUT_IDLE_MS = 3000;
  const OUTPUT_HOVER_EXPAND_MS = 3000;
  const OUTPUT_COLLAPSED_HEIGHT = 40;
  const [whiteboardHeight, setWhiteboardHeight] = useState(
    () => loadSettings().whiteboardHeight ?? 220
  );
  const [pipDragging, setPipDragging] = useState(false);
  const pipDraggingRef = useRef(false);
  const pipResizeDraggingRef = useRef(false);
  /** Minimap amber PiP drag — same as main PiP drag: overlay must repaint every frame (avoid stroke vs video desync). */
  const wbMiniPipDraggingRef = useRef(false);
  const wbMiniPipLiveCompositeRafRef = useRef(0);
  /** Coalesce one React commit per frame during minimap PiP drag so portal/minimap props re-read `fullPagePipPosRef` (stale VDOM must not overwrite `applyWbMiniPipLiveLayoutDom` patches). */
  const wbMiniPipLayoutBumpRafRef = useRef(0);
  const [wbMiniPipLayoutTick, setWbMiniPipLayoutTick] = useState(0);
  const scheduleWbMiniPipLayoutSyncFromRef = useCallback(() => {
    if (wbMiniPipLayoutBumpRafRef.current) return;
    wbMiniPipLayoutBumpRafRef.current = requestAnimationFrame(() => {
      wbMiniPipLayoutBumpRafRef.current = 0;
      setWbMiniPipLayoutTick((n) => (n + 1) & 65535);
    });
  }, []);
  const snapPipPortalLayer = useMemo(() => {
    if (pipEffectBackend !== "snap" || avatarImageSrc) return null;
    const cfg = getSnapCameraKitConfig();
    if (!cfg) return null;
    return (
      <Suspense fallback={null}>
        <div
          className="absolute inset-0 overflow-hidden"
          style={{
            borderRadius: avatarShape === "circle" ? "50%" : AVATAR_RECT_RADIUS,
            zIndex: 1,
          }}
        >
          <SnapPipLens
            apiToken={cfg.apiToken}
            lensId={cfg.lensId}
            lensGroupId={cfg.lensGroupId}
            pipDragging={pipDragging}
            onLiveCanvas={onSnapLiveCanvas}
            className="h-full w-full"
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      </Suspense>
    );
  }, [pipEffectBackend, avatarImageSrc, avatarShape, pipDragging, onSnapLiveCanvas]);
  const pipOffsetRef = useRef({ x: 0, y: 0 });
  const [previewBoxDragging, setPreviewBoxDragging] = useState(false);
  const previewBoxDraggingRef = useRef(false);
  const previewBoxOffsetRef = useRef({ x: 0, y: 0 });
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureErrorExiting, setCaptureErrorExiting] = useState(false);
  const captureScreenInFlightRef = useRef(false);
  /** macOS Electron: main sends sources; user picks before `getDisplayMedia` resolves. */
  const [displayMediaPicker, setDisplayMediaPicker] = useState<
    { id: string; name: string; thumbnailDataUrl?: string }[] | null
  >(null);
  /** Throttle macOS trim + reduce flicker (per-frame re-trim oscillates). */
  const screenTrimCacheRef = useRef<{ key: string; rect: ScreenTrimRect } | null>(null);
  const screenTrimFrameRef = useRef(0);
  /** Subpixel layout can flip `clientWidth`/`clientHeight` by 1px → composite canvas `width`/`height` reset every frame (GPU churn, jank, can hitch fullscreen captures like Keynote). */
  const screenSharePaneStableRef = useRef<{ w: number; h: number } | null>(null);
  /** Hysteresis for `videoWidth`×`videoHeight` during getDisplayMedia (reduces contain-scale wobble). */
  const screenShareStableIntrinsicRef = useRef<{ sw: number; sh: number } | null>(null);
  const screenShareIntrinsicTrackIdRef = useRef<string | null>(null);
  /** Hold last drawImage dest when trim + geometry are unchanged and movement is ≤2px (stops ±1px shimmer). */
  const screenShareDrawDestRef = useRef<{
    trimKey: string;
    tx: number;
    ty: number;
    tw: number;
    th: number;
  } | null>(null);
  /** Last share-rect slack for portrait drag (bitmap px). */
  const sharePanLayoutRef = useRef<{ w: number; h: number; dw: number; dh: number; dx: number; dy: number } | null>(null);
  const sharePanOverlayRef = useRef<HTMLDivElement | null>(null);
  const sharePanOverlayRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const shareOverlayResizeDragActiveRef = useRef(false);
  const shareInteractionDrawRafRef = useRef<number | null>(null);
  const shareInteractionPaneLockRef = useRef<{ w: number; h: number } | null>(null);
  const sharePortraitPanDragRef = useRef<
    | {
        mode: "pan";
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startClientW: number;
        startClientH: number;
        startNormX: number;
        startNormY: number;
      }
    | {
        mode: "resizePct";
        pointerId: number;
        corner: ShareResizeCorner;
        startClientX: number;
        startClientY: number;
        startPct: number;
        lastPct: number;
      }
    | null
  >(null);

  const fullPageWhiteboard = true;
  const activeScreenStream = whiteboardScreenStream ?? previewScreenStream;
  const activeScreenStreamRef = useRef(activeScreenStream);
  activeScreenStreamRef.current = activeScreenStream;
  useEffect(() => {
    screenTrimCacheRef.current = null;
    screenTrimFrameRef.current = 0;
    resetScreenShareTrimState();
    screenSharePaneStableRef.current = null;
    screenShareDrawDestRef.current = null;
    screenShareStableIntrinsicRef.current = null;
    screenShareIntrinsicTrackIdRef.current = null;
    sharePanLayoutRef.current = null;
    sharePortraitPanDragRef.current = null;
  }, [activeScreenStream]);

  /** Auto-dismiss capture/recording errors: fade/slide out, then unmount (instant clear if reduced motion). */
  useEffect(() => {
    if (!captureError) {
      setCaptureErrorExiting(false);
      return;
    }
    setCaptureErrorExiting(false);
    const reducedMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      const id = window.setTimeout(() => setCaptureError(null), CAPTURE_ERROR_VISIBLE_MS);
      return () => clearTimeout(id);
    }
    const fadeId = window.setTimeout(() => setCaptureErrorExiting(true), CAPTURE_ERROR_VISIBLE_MS);
    const removeId = window.setTimeout(() => {
      setCaptureError(null);
      setCaptureErrorExiting(false);
    }, CAPTURE_ERROR_VISIBLE_MS + CAPTURE_ERROR_EXIT_MS);
    return () => {
      clearTimeout(fadeId);
      clearTimeout(removeId);
    };
  }, [captureError]);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  isRecordingRef.current = isRecording;

  const getLandmarkVideo = useCallback(
    (): HTMLVideoElement | null =>
      pickDecodedCameraVideo(cameraVideoRef.current, cameraSourceVideoRef.current),
    []
  );

  useFaceLandmarksWorker({
    enabled:
      pipEffectBackend === "mediapipe" &&
      faceFilter !== "none" &&
      showPip &&
      !avatarImageSrc,
    getVideo: getLandmarkVideo,
    isRecordingRef,
    pipDraggingRef,
    previewBoxDraggingRef,
    faceLandmarksRef,
    lastValidLandmarksRef,
    lastValidLandmarksAtRef,
  });

  useEffect(() => {
    if (pipEffectBackend === "snap" && !snapCameraKitEnvConfigured()) {
      setPipEffectBackend("mediapipe");
    }
  }, [pipEffectBackend]);

  /** PiP position refs — sync `pipPosRef` from state when idle only (non-recording). `fullPagePipPosRef` mirrors `fullPagePipPos` in `useLayoutEffect` below except while main canvas PiP drag owns the ref. */
  const pipPosRef = useRef(pipPos);
  const fullPagePipPosRef = useRef(fullPagePipPos);
  if (!isRecording && !pipDraggingRef.current) {
    pipPosRef.current = pipPos;
  }

  useLayoutEffect(() => {
    /** Main PiP drag skips sync (onMove owns ref); minimap amber drag must too — otherwise any `fullPagePipPos` churn overwrites ref with stale state → portal snaps away / “disappears”. */
    if (pipDraggingRef.current || wbMiniPipDraggingRef.current) return;
    /**
     * While **recording**, portal + minimap + composite follow `fullPagePipPosRef` (see `fullPagePipForRender` for both WB-only and Capture-Screen WB paths).
     * Mirroring React state into the ref copied bad state (RO, hydration timing, effects) into the ref and snapped PiP to (0,0).
     */
    if (isRecordingRef.current) return;
    fullPagePipPosRef.current = fullPagePipPos;
  }, [fullPagePipPos, fullPageWhiteboard, isRecording]);
  const wbOnlyUi = fullPageWhiteboard && !activeScreenStream;
  /** Screen-share recording reads `fullPagePipPosRef` so parked / dragged PiP matches composite without waiting on state flush. */
  const fullPagePipForRender =
    pipDragging ||
    (isRecording && wbOnlyUi) ||
    (isRecording && fullPageWhiteboard && activeScreenStream)
      ? fullPagePipPosRef.current
      : fullPagePipPos;
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedClips, setRecordedClips] = useState<{ id: number; blob: Blob }[]>([]);
  const clipIdRef = useRef(0);
  const recordingTimeElapsedRef = useRef(0);
  const { width } = useWindowSize();
  const windowLiveResize = useWindowLiveResize(100);
  const isCompact = width < 520;
  const isElectron =
    typeof window !== "undefined" &&
    !!(window as unknown as { electronAPI?: unknown }).electronAPI;
  const settingsLoadedRef = useRef(!isElectron);
  const [omitPipFromRecording, setOmitPipFromRecording] = useState(
    () => loadSettings().omitPipFromRecording ?? false
  );
  const [autoParkPipOnRecordStart, setAutoParkPipOnRecordStart] = useState(
    () => loadSettings().autoParkPipOnRecordStart ?? false
  );

  // Electron: disk → React (single load). Web: hydrate merge snapshot so partial saves use one coherent blob.
  useEffect(() => {
    if (!isElectron) {
      hydratePersistedSettingsSnapshot(loadSettings());
      return;
    }
    loadSettingsAsync().then((loaded) => {
      settingsLoadedRef.current = true;
      const s = loaded;
      if (s.whiteboardPanelWidth != null) {
        const w = Math.max(SPLIT_STRIP_MIN_PX, Math.round(s.whiteboardPanelWidth));
        whiteboardPanelWidthRef.current = w;
        setWhiteboardPanelWidth(w);
      } else {
        whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
        setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX);
      }
      if (s.avatarImageSrc != null) setAvatarImageSrc(s.avatarImageSrc);
      if (s.avatarSize != null) setAvatarSize(s.avatarSize);
      if (s.avatarShape != null) setAvatarShape(s.avatarShape);
      if (s.avatarDecor != null) setAvatarDecor(s.avatarDecor);
      if (s.glowColor != null) setGlowColor(s.glowColor);
      if (s.beautyMode != null) setBeautyMode(s.beautyMode);
      if (s.beautySettings != null) setBeautySettings(s.beautySettings);
      if (s.faceFilter != null) setFaceFilter(normalizeFaceFilterFromStorage(s.faceFilter));
      if (s.pipEffectBackend === "snap" && snapCameraKitEnvConfigured()) setPipEffectBackend("snap");
      else if (s.pipEffectBackend === "mediapipe") setPipEffectBackend("mediapipe");
      if (s.pipPos != null) setPipPos(s.pipPos);
      if (s.fullPagePipPos != null && !isRecordingRef.current) setFullPagePipPos(s.fullPagePipPos);
      if (s.sidebarWidth != null) setSidebarWidth(s.sidebarWidth);
      if (s.previewWidth != null) setPreviewWidth(s.previewWidth);
      if (s.whiteboardHeight != null) setWhiteboardHeight(s.whiteboardHeight);
      if (s.micVolume != null) setMicVolume(s.micVolume);
      if (s.systemVolume != null) setSystemVolume(s.systemVolume);
      if (s.recordResolution != null) setRecordResolution(s.recordResolution);
      if (s.recordOutputShape != null) setRecordOutputShape(s.recordOutputShape);
      if (s.shareWindowFillPercent != null && s.shareWindowFillPercent >= 40 && s.shareWindowFillPercent <= 100) {
        setShareWindowFillPercent(Math.round(s.shareWindowFillPercent));
      }
      if (s.sharePortraitWindowPanNorm != null) {
        setSharePortraitWindowPanNorm(s.sharePortraitWindowPanNorm);
      }
      if (s.whiteboardRecordSurfacePanNorm != null) {
        const pn = s.whiteboardRecordSurfacePanNorm;
        if (pn && typeof pn.x === "number" && typeof pn.y === "number") {
          setWhiteboardRecordSurfacePanNorm({
            x: Math.min(1, Math.max(-1, pn.x)),
            y: Math.min(1, Math.max(-1, pn.y)),
          });
        }
      }
      /** Letterbox: disk hydrate must not wipe an in-flight upload (async often resolves after user picks a file). */
      {
        const prevImg = letterboxCustomImageDataUrlRef.current;
        let mergedImg: string | null;
        if (s.letterboxCustomImage != null) {
          mergedImg =
            prevImg != null && prevImg !== s.letterboxCustomImage ? prevImg : s.letterboxCustomImage;
        } else if (prevImg != null) {
          mergedImg = prevImg;
        } else {
          mergedImg = null;
        }
        setLetterboxCustomImage(mergedImg);
        setLetterboxBackground((prev) => {
          if (s.letterboxBackground == null) return prev;
          if (
            prev === "custom" &&
            s.letterboxBackground === "black" &&
            mergedImg &&
            !s.letterboxCustomImage
          ) {
            return "custom";
          }
          return s.letterboxBackground;
        });
        setLetterboxMode((prev) => (s.letterboxMode != null ? s.letterboxMode : prev));
      }
      if (s.previewPosition != null) setPreviewPosition(s.previewPosition);
      if (s.previewLayoutMode != null) setPreviewLayoutMode(s.previewLayoutMode);
      if (s.fullPagePreviewPos != null) setFullPagePreviewPos(s.fullPagePreviewPos);
      if (s.omitPipFromRecording != null) setOmitPipFromRecording(s.omitPipFromRecording);
      if (s.autoParkPipOnRecordStart != null) setAutoParkPipOnRecordStart(s.autoParkPipOnRecordStart);
      if (s.settingsPanelGeom != null) setSettingsPanelGeom(clampSettingsPanelGeom(s.settingsPanelGeom));

      const list = getTeleprompterScripts(s);
      const aid =
        s.activeTeleprompterScriptId && list.some((x) => x.id === s.activeTeleprompterScriptId)
          ? s.activeTeleprompterScriptId
          : list[0]?.id ?? "default";
      setTeleprompterScripts(list);
      setActiveTeleprompterScriptId(aid);
      if (s.teleprompterSpeed != null) setTeleprompterSpeed(s.teleprompterSpeed);
      if (s.teleprompterFontSize != null) setTeleprompterFontSize(s.teleprompterFontSize);
      if (s.teleprompterOpacity != null) setTeleprompterOpacity(s.teleprompterOpacity);
      if (s.teleprompterWidth != null) setTeleprompterWidth(s.teleprompterWidth);
      if (s.teleprompterHeight != null) setTeleprompterHeight(s.teleprompterHeight);
      if (s.teleprompterPanelWidth != null) setTeleprompterPanelWidth(s.teleprompterPanelWidth);
      if (s.teleprompterPanelHeight != null) setTeleprompterPanelHeight(s.teleprompterPanelHeight);
      if (s.teleprompterVoskLang === "en" || s.teleprompterVoskLang === "zh" || s.teleprompterVoskLang === "it") {
        setTeleprompterVoskLang(s.teleprompterVoskLang);
      }

      hydratePersistedSettingsSnapshot(s);
      setElectronSettingsEpoch((e) => e + 1);
    });
  }, [isElectron]);

  useEffect(() => {
    if (!isElectron) return;
    const api = (
      window as unknown as {
        electronAPI?: {
          onDisplayMediaPicker?: (cb: (sources: { id: string; name: string; thumbnailDataUrl?: string }[]) => void) => () => void;
        };
      }
    ).electronAPI;
    if (!api?.onDisplayMediaPicker) return;
    const unsub = api.onDisplayMediaPicker((sources) => {
      setDisplayMediaPicker(sources);
    });
    return () => unsub?.();
  }, [isElectron]);

  useEffect(() => {
    if (!displayMediaPicker?.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void (
          window as unknown as { electronAPI?: { displayMediaCancel?: () => Promise<void> } }
        ).electronAPI?.displayMediaCancel?.();
        setDisplayMediaPicker(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [displayMediaPicker]);

  const [showOutput, setShowOutput] = useState(false);
  useEffect(() => {
    if (!showOutput || recordedClips.length === 0) return;
    setOutputCollapsed(false);
    outputIdleTimerRef.current = window.setTimeout(() => {
      outputIdleTimerRef.current = null;
      setOutputCollapsed(true);
    }, OUTPUT_IDLE_MS);
    return () => {
      if (outputIdleTimerRef.current) {
        clearTimeout(outputIdleTimerRef.current);
        outputIdleTimerRef.current = null;
      }
      if (outputHoverExpandTimerRef.current) {
        clearTimeout(outputHoverExpandTimerRef.current);
        outputHoverExpandTimerRef.current = null;
      }
    };
  }, [showOutput, recordedClips.length]);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);
  const [settingsPanelGeom, setSettingsPanelGeom] = useState<SettingsPanelGeom>(() => {
    const saved = loadSettings().settingsPanelGeom;
    return saved != null ? saved : defaultSettingsPanelGeom();
  });

  useEffect(() => {
    const onResize = () => setSettingsPanelGeom((g) => clampSettingsPanelGeom(g));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const [showLiveMeetingModal, setShowLiveMeetingModal] = useState(false);
  const [inLiveMeeting, setInLiveMeeting] = useState(false);
  const liveMeetingRef = useRef<LiveMeetingModalHandle | null>(null);
  const [micVolume, setMicVolume] = useState(() => loadSettings().micVolume ?? 100);
  const [systemVolume, setSystemVolume] = useState(() => loadSettings().systemVolume ?? 80);
  const [recordResolution, setRecordResolution] = useState<RecordResolution>(
    () => loadSettings().recordResolution ?? "1080p"
  );
  const [recordOutputShape, setRecordOutputShape] = useState<RecordOutputShape>(
    () => loadSettings().recordOutputShape ?? "landscape_16_9"
  );
  const [shareWindowFillPercent, setShareWindowFillPercent] = useState(() => {
    const v = loadSettings().shareWindowFillPercent;
    if (typeof v !== "number" || v < 40 || v > 100) return 80;
    return Math.round(v);
  });
  /** True while minimap Share% SE handle is dragging — ref holds live %; avoid syncing from React state that frame. */
  const wbMiniShareResizeDragActiveRef = useRef(false);
  const shareWindowFillPercentRef = useRef(shareWindowFillPercent);
  if (!wbMiniShareResizeDragActiveRef.current && !shareOverlayResizeDragActiveRef.current) {
    shareWindowFillPercentRef.current = shareWindowFillPercent;
  }

  const sharePortraitPanNormRef = useRef<{ x: number; y: number }>(
    (() => {
      const p = loadSettings().sharePortraitWindowPanNorm;
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        return { x: Math.min(1, Math.max(-1, p.x)), y: Math.min(1, Math.max(-1, p.y)) };
      }
      return { x: 0, y: 0 };
    })()
  );

  const [sharePortraitWindowPanNorm, setSharePortraitWindowPanNorm] = useState<{ x: number; y: number }>(
    () => sharePortraitPanNormRef.current
  );

  useEffect(() => {
    sharePortraitPanNormRef.current = sharePortraitWindowPanNorm;
  }, [sharePortraitWindowPanNorm]);

  const [whiteboardRecordSurfacePanNorm, setWhiteboardRecordSurfacePanNorm] = useState<{
    x: number;
    y: number;
  }>(() => {
    const p = loadSettings().whiteboardRecordSurfacePanNorm;
    if (p && typeof p.x === "number" && typeof p.y === "number") {
      return { x: Math.min(1, Math.max(-1, p.x)), y: Math.min(1, Math.max(-1, p.y)) };
    }
    return { x: 0, y: 0 };
  });
  const [wbLayoutMiniExpanded, setWbLayoutMiniExpanded] = useState(true);
  /** Never default to 1×1 — `wbRecordPipOutputRect` + minimap then collapse PiP to the encoded top-left. */
  const [wbMiniLayoutSnap, setWbMiniLayoutSnap] = useState({
    pipMapW: 960,
    pipMapH: 540,
    iw: 1920,
    ih: 1080,
  });

  /**
   * Minimap PiP letterbox MUST match drawComposite wbPipUniformEncode, which maps from
   * `captureLayoutEl.getBoundingClientRect()` — for WB-only that is **previewRef** (inset overlay).
   * useLayoutEffect: avoid an effect-frame where state is still tiny defaults (pointermove clamps pCss→(0,0) → PiP vanishes + export glued to letterbox corner).
   */
  useLayoutEffect(() => {
    if (!isRecording || !fullPageWhiteboard || activeScreenStream) return;
    let ro: ResizeObserver | null = null;
    let cancelled = false;
    let raf = 0;
    const apply = () => {
      if (wbMiniPipDraggingRef.current) return;
      const preview = previewRef.current;
      if (!preview) return;
      const r = preview.getBoundingClientRect();
      /** Match `previewStable` in drawComposite — transient 0×0 / tiny rects corrupt letterbox `s` and PiP px size (minimap sliver / (0,0) clamp). */
      if (r.width < 50 || r.height < 50) return;
      const { iw, ih } = wbRecordingIwihRef.current;
      const pipMapW = Math.max(1, Math.round(r.width));
      const pipMapH = Math.max(1, Math.round(r.height));
      setWbMiniLayoutSnap((prev) => {
        if (prev.pipMapW === pipMapW && prev.pipMapH === pipMapH && prev.iw === iw && prev.ih === ih) return prev;
        return { pipMapW, pipMapH, iw, ih };
      });
    };
    const attach = () => {
      if (cancelled) return;
      const preview = previewRef.current;
      if (!preview) {
        raf = requestAnimationFrame(attach);
        return;
      }
      apply();
      ro = new ResizeObserver(apply);
      ro.observe(preview);
      const parent = preview.parentElement;
      if (parent) ro.observe(parent);
    };
    attach();
    const iwIhTicker = window.setInterval(apply, 400);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.clearInterval(iwIhTicker);
    };
  }, [isRecording, fullPageWhiteboard, activeScreenStream]);

  const recordOutputDimensions = useMemo(
    () => getRecordOutputDimensions(recordResolution, recordOutputShape),
    [recordResolution, recordOutputShape]
  );
  /* Record vs UI naming:
   * - Output frame: `recordOutputDimensions` — encoded video full bounds (landscape 16∶9 / 16∶10 or portrait 3∶4 / 9∶16).
   * - Share window: screen draw inside that frame at Settings “Share” % (contain + optional pan), not the outer black letterbox.
   * - Capture preview shell: right column chrome (border/ring); preview canvas is fitted to output aspect inside the pane. */

  const [letterboxBackground, setLetterboxBackground] = useState<LetterboxBackground>(
    () => loadSettings().letterboxBackground ?? "black"
  );
  const [letterboxCustomImage, setLetterboxCustomImage] = useState<string | null>(
    () => loadSettings().letterboxCustomImage ?? null
  );
  const [letterboxMode, setLetterboxMode] = useState<LetterboxMode>(
    () => loadSettings().letterboxMode ?? "fit"
  );
  /** Electron: async disk load can finish after user uploads a bg image; ref used to merge without wiping in-flight data. */
  const letterboxCustomImageDataUrlRef = useRef<string | null>(null);
  letterboxCustomImageDataUrlRef.current = letterboxCustomImage;

  const [previewPosition, setPreviewPosition] = useState<
    "top-left" | "top-right" | "bottom-left" | "bottom-right"
  >(() => loadSettings().previewPosition ?? "top-left");
  const [previewLayoutMode, setPreviewLayoutMode] = useState<
    "overlay" | "side-right" | "side-bottom"
  >(() => loadSettings().previewLayoutMode ?? "overlay");
  const [fullPagePreviewPos, setFullPagePreviewPos] = useState<{ x: number; y: number } | null>(
    () => loadSettings().fullPagePreviewPos ?? null
  );
  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [teleprompterPlaying, setTeleprompterPlaying] = useState(false);
  const defaultScript = "Hook line.\n\nMain point one.\n\nMain point two.\n\nCall to action.";
  const [teleprompterScripts, setTeleprompterScripts] = useState<TeleprompterScript[]>(() =>
    getTeleprompterScripts(loadSettings())
  );
  const [activeTeleprompterScriptId, setActiveTeleprompterScriptId] = useState<string>(() => {
    const s = loadSettings();
    const list = getTeleprompterScripts(s);
    const aid = s.activeTeleprompterScriptId && list.some((x) => x.id === s.activeTeleprompterScriptId)
      ? s.activeTeleprompterScriptId
      : list[0]?.id ?? "default";
    return aid;
  });
  const [teleprompterSpeed, setTeleprompterSpeed] = useState(() => loadSettings().teleprompterSpeed ?? 30);
  const [teleprompterFontSize, setTeleprompterFontSize] = useState(() => loadSettings().teleprompterFontSize ?? 32);
  const [teleprompterOpacity, setTeleprompterOpacity] = useState(() => loadSettings().teleprompterOpacity ?? 0.68);
  const [teleprompterWidth, setTeleprompterWidth] = useState(() => loadSettings().teleprompterWidth ?? 560);
  const [teleprompterHeight, setTeleprompterHeight] = useState(() => loadSettings().teleprompterHeight ?? 210);
  const [teleprompterPanelWidth, setTeleprompterPanelWidth] = useState(() => loadSettings().teleprompterPanelWidth ?? 420);
  const [teleprompterPanelHeight, setTeleprompterPanelHeight] = useState(() => loadSettings().teleprompterPanelHeight ?? 520);
  const [teleprompterNearCamera, setTeleprompterNearCamera] = useState(true);
  const [teleprompterPosition, setTeleprompterPosition] = useState<{ x: number; y: number } | null>(null);
  const [teleprompterPanelPosition, setTeleprompterPanelPosition] = useState<{ x: number; y: number } | null>(null);
  const [teleprompterLocked, setTeleprompterLocked] = useState(false);
  const [teleprompterFollowMode, setTeleprompterFollowMode] = useState(false);
  const [teleprompterVoskLang, setTeleprompterVoskLang] = useState<TeleprompterVoskLang>(() => {
    const v = loadSettings().teleprompterVoskLang;
    if (v === "zh" || v === "it") return v;
    if (v === "auto") return "zh";
    return "en";
  });
  const [teleprompterSlimMode, setTeleprompterSlimMode] = useState(false);
  const [teleprompterResetSeq, setTeleprompterResetSeq] = useState(0);
  const [teleprompterEditorScrollRatio, setTeleprompterEditorScrollRatio] = useState<number | null>(null);
  const [teleprompterAnchorRect, setTeleprompterAnchorRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const teleprompterChannelRef = useRef<BroadcastChannel | null>(null);
  const teleprompterStateRef = useRef<{
    visible: boolean;
    detached: boolean;
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
  } | null>(null);
  const teleprompterWindowRef = useRef<Window | null>(null);
  const monitorWindowRef = useRef<Window | null>(null);
  const teleprompterSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teleprompterSaveRef = useRef({
    scripts: teleprompterScripts,
    activeId: activeTeleprompterScriptId,
    speed: teleprompterSpeed,
    fontSize: teleprompterFontSize,
    opacity: teleprompterOpacity,
    width: teleprompterWidth,
    height: teleprompterHeight,
    panelWidth: teleprompterPanelWidth,
    panelHeight: teleprompterPanelHeight,
    voskLang: teleprompterVoskLang,
  });
  teleprompterSaveRef.current = {
    scripts: teleprompterScripts,
    activeId: activeTeleprompterScriptId,
    speed: teleprompterSpeed,
    fontSize: teleprompterFontSize,
    opacity: teleprompterOpacity,
    width: teleprompterWidth,
    height: teleprompterHeight,
    panelWidth: teleprompterPanelWidth,
    panelHeight: teleprompterPanelHeight,
    voskLang: teleprompterVoskLang,
  };
  const currentTeleprompterScript = teleprompterScripts.find((s) => s.id === activeTeleprompterScriptId);
  const teleprompterScript = currentTeleprompterScript?.content ?? defaultScript;

  const [electronSettingsEpoch, setElectronSettingsEpoch] = useState(0);

  useEffect(() => {
    if (teleprompterSaveTimeoutRef.current) clearTimeout(teleprompterSaveTimeoutRef.current);
    teleprompterSaveTimeoutRef.current = setTimeout(() => {
      teleprompterSaveTimeoutRef.current = null;
      const run = () => {
        const r = teleprompterSaveRef.current;
        const base = saveTeleprompterScripts(getSettingsMergeBase(), r.scripts, r.activeId);
        saveSettings({
          ...base,
          teleprompterSpeed: r.speed,
          teleprompterFontSize: r.fontSize,
          teleprompterOpacity: r.opacity,
          teleprompterWidth: r.width,
          teleprompterHeight: r.height,
          teleprompterPanelWidth: r.panelWidth,
          teleprompterPanelHeight: r.panelHeight,
          teleprompterVoskLang: r.voskLang,
        });
      };
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(run, { timeout: 2500 });
      } else {
        run();
      }
    }, 450);
    return () => {
      if (teleprompterSaveTimeoutRef.current) clearTimeout(teleprompterSaveTimeoutRef.current);
    };
  }, [
    teleprompterScripts,
    activeTeleprompterScriptId,
    teleprompterSpeed,
    teleprompterFontSize,
    teleprompterOpacity,
    teleprompterWidth,
    teleprompterHeight,
    teleprompterPanelWidth,
    teleprompterPanelHeight,
    teleprompterVoskLang,
  ]);

  const flushTeleprompterSave = useCallback((pendingScriptContent?: string) => {
    if (teleprompterSaveTimeoutRef.current) {
      clearTimeout(teleprompterSaveTimeoutRef.current);
      teleprompterSaveTimeoutRef.current = null;
    }
    const r = teleprompterSaveRef.current;
    let scripts = r.scripts;
    const activeId = r.activeId;
    if (pendingScriptContent !== undefined) {
      const now = Date.now();
      scripts = scripts.map((s) =>
        s.id === activeId ? { ...s, content: pendingScriptContent, updatedAt: now } : s
      );
      teleprompterSaveRef.current = { ...r, scripts };
    }
    const base = saveTeleprompterScripts(getSettingsMergeBase(), scripts, activeId);
    saveSettings({
      ...base,
      teleprompterSpeed: r.speed,
      teleprompterFontSize: r.fontSize,
      teleprompterOpacity: r.opacity,
      teleprompterWidth: r.width,
      teleprompterHeight: r.height,
      teleprompterPanelWidth: r.panelWidth,
      teleprompterPanelHeight: r.panelHeight,
      teleprompterVoskLang: r.voskLang,
    });
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => {
      flushTeleprompterSave();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [flushTeleprompterSave]);

  const handleSetTeleprompterScript = useCallback(
    (content: string) => {
      const now = Date.now();
      startTransition(() => {
        setTeleprompterScripts((prev) =>
          prev.map((s) =>
            s.id === activeTeleprompterScriptId ? { ...s, content, updatedAt: now } : s
          )
        );
      });
    },
    [activeTeleprompterScriptId]
  );

  const handleSwitchTeleprompterScript = useCallback((id: string) => {
    const s = teleprompterScripts.find((x) => x.id === id);
    if (!s || id === activeTeleprompterScriptId) return;
    setActiveTeleprompterScriptId(id);
  }, [teleprompterScripts, activeTeleprompterScriptId]);

  const handleNewTeleprompterScript = useCallback(() => {
    const id = "script-" + Date.now();
    const script: TeleprompterScript = { id, name: "Untitled", content: "", updatedAt: Date.now() };
    setTeleprompterScripts((prev) => [...prev, script]);
    setActiveTeleprompterScriptId(id);
  }, []);

  const handleImportTeleprompterScripts = useCallback((items: { name: string; content: string }[]) => {
    if (!items.length) return;
    const t = Date.now();
    const newScripts: TeleprompterScript[] = items.map((item, i) => ({
      id: `script-${t}-${i}`,
      name: item.name,
      content: normalizeTeleprompterImportedText(item.content),
      updatedAt: t,
    }));
    setTeleprompterScripts((prev) => [...prev, ...newScripts]);
    setActiveTeleprompterScriptId(newScripts[newScripts.length - 1]!.id);
  }, []);

  const handleSaveAsTeleprompterScript = useCallback(() => {
    const name = (typeof window !== "undefined" ? window.prompt("Script name:", "Untitled") : null) || "Untitled";
    const id = "script-" + Date.now();
    const content = currentTeleprompterScript?.content ?? "";
    const script: TeleprompterScript = { id, name, content, updatedAt: Date.now() };
    setTeleprompterScripts((prev) => [...prev, script]);
    setActiveTeleprompterScriptId(id);
  }, [currentTeleprompterScript?.content]);

  const handleRenameTeleprompterScript = useCallback(
    (newName: string) => {
      const trimmed = newName.trim() || (currentTeleprompterScript?.name ?? "Untitled");
      if (trimmed === currentTeleprompterScript?.name) return;
      setTeleprompterScripts((prev) =>
        prev.map((p) => (p.id === activeTeleprompterScriptId ? { ...p, name: trimmed } : p))
      );
    },
    [currentTeleprompterScript?.name, activeTeleprompterScriptId]
  );

  const helperOpenInFlightRef = useRef<{ teleprompter: boolean; monitor: boolean }>({
    teleprompter: false,
    monitor: false,
  });
  const helperOpenRef = useRef<(kind: "teleprompter" | "monitor") => void>(() => undefined);
  const recordLoopLastAtRef = useRef(0);
  /** Throttle camera mirror cache while recording screen share (PiP is small; saves a full drawImage per frame). */
  const screenRecCamCacheTickRef = useRef(0);
  const letterboxCustomImgRef = useRef<HTMLImageElement | null>(null);
  const handleWhiteboardLayersChange = useCallback((layers: HTMLCanvasElement[]) => {
    whiteboardCanvasLayersRef.current = layers;
  }, []);

  const handleExcalidrawReady = useCallback(
    (api: { getSceneElements: () => readonly unknown[]; getAppState: () => Record<string, unknown>; getFiles: () => Record<string, unknown> }) => {
      excalidrawAPIRef.current = api;
    },
    []
  );

  const wbImmediateExportRef = useRef<(() => void) | null>(null);
  const handleWhiteboardSceneChange = useCallback(() => {
    wbImmediateExportRef.current?.();
  }, []);

  const [whiteboardTextureId, setWhiteboardTextureId] = useState<string | null>(null);
  const handleWhiteboardTextureChange = useCallback((textureId: string | null) => {
    whiteboardTextureRef.current = textureId;
    setWhiteboardTextureId(textureId);
  }, []);

  const WHITEBOARD_TEXTURE_BASE = `${import.meta.env.BASE_URL}whiteboard-textures/`;
  useEffect(() => {
    const id = whiteboardTextureId;
    if (!id) {
      whiteboardTextureImgRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => { whiteboardTextureImgRef.current = img; };
    img.onerror = () => { whiteboardTextureImgRef.current = null; };
    img.src = WHITEBOARD_TEXTURE_BASE + id;
    if (img.complete) whiteboardTextureImgRef.current = img;
    return () => { whiteboardTextureImgRef.current = null; };
  }, [whiteboardTextureId]);

  // Bring window to foreground on launch (macOS often leaves it behind) — only after app has mounted
  useEffect(() => {
    if (isElectron && typeof window !== "undefined") {
      window.focus();
    }
  }, [isElectron]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const drawLoopIdRef = useRef<number | null>(null);
  const previewLoopLastAtRef = useRef(0);
  const recordingDrawAndDisplayRef = useRef<(() => void) | null>(null);
  const recordingUsedRafRef = useRef(false);
  const timerIdRef = useRef<number | null>(null);
  const recordingStartRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const recordingAudioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recordingScreenAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingSysGainRef = useRef<GainNode | null>(null);
  /** 全屏白板录制开始时快照 content/preview 的 CSS 尺寸，避免录制过程中 offsetWidth 抖动导致 scaleX/Y 微变 → 画面轻微颤动 */
  const recordWhiteboardPreviewSizeRef = useRef<{ w: number; h: number } | null>(null);
  /** captureStream 的视频轨；每帧合成后 requestFrame，否则离屏/低可见 canvas 在部分环境下不把人像送进编码器 */
  const canvasCaptureTrackRef = useRef<MediaStreamTrack | null>(null);
  const stopDrawLoopRef = useRef<(() => void) | null>(null);
  /** When `dreamwork_capture_debug=1`: frames where screen <video> was eligible vs not (see drawComposite). */
  const captureDebugScreenHitRef = useRef(0);
  const captureDebugScreenMissRef = useRef(0);
  const captureDebugThrottleAtRef = useRef(0);

  const hasScreen = !!activeScreenStream;
  hasScreenLayoutRef.current = hasScreen || captureMainNoStream;

  /** Which column gets `1fr`: capture preview vs whiteboard (see `splitGridTemplate`). */
  const splitMainIsCapture =
    (hasScreen || captureMainNoStream) && !(hasScreen && preferWhiteboardMain);
  const splitMainIsCaptureRef = useRef(splitMainIsCapture);
  splitMainIsCaptureRef.current = splitMainIsCapture;
  /** Enter squeeze → capture-main without stream: wb column (wb-main) ≤ min ⇒ right column should be 1fr. */
  useEffect(() => {
    if (hasScreen) {
      setCaptureMainNoStream(false);
      return;
    }
    if (captureMainNoStream) return;
    const cw =
      contentAreaSplitWidth > 0
        ? contentAreaSplitWidth
        : (contentAreaRef.current?.offsetWidth ?? 0);
    const sp = Math.max(SPLIT_STRIP_MIN_PX, Math.round(whiteboardPanelWidthRef.current));
    const wbMainCol = cw > 0 ? Math.max(0, cw - 14 - sp) : 0;
    if (cw > 0 && wbMainCol <= SPLIT_STRIP_MIN_PX) {
      setCaptureMainNoStream(true);
      whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
      setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX);
    }
  }, [hasScreen, contentAreaSplitWidth, captureMainNoStream, whiteboardPanelWidth]);

  useEffect(() => {
    if (!hasScreen) setPreferWhiteboardMain(false);
  }, [hasScreen]);

  const hasCamera = showPip;
  const detachedHelpersEnabled = isElectron && !!activeScreenStream;

  useEffect(() => {
    if (!showPip) {
      setTeleprompterAnchorRect(null);
      setTeleprompterNearCamera(false);
      return;
    }
    if (!showTeleprompter || !teleprompterNearCamera) {
      setTeleprompterAnchorRect(null);
      return;
    }
    const tick = () => {
      if (pipDraggingRef.current) return;
      const rect = pipRef.current?.getBoundingClientRect();
      setTeleprompterAnchorRect((prev) => {
        if (!rect) return prev === null ? prev : null;
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
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => clearInterval(id);
  }, [showTeleprompter, teleprompterNearCamera, showPip]);

  const handleToggleTeleprompter = () => {
    setShowTeleprompter((prev) => {
      const next = !prev;
      if (!next) {
        setTeleprompterPlaying(false);
        setTeleprompterFollowMode(false);
        setTeleprompterSlimMode(false);
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
        void closeHelperByLabel("teleprompter-slim");
      }
      return next;
    });
  };

  const handleResetTeleprompter = () => {
    setTeleprompterPlaying(false);
    setTeleprompterEditorScrollRatio(null);
    setTeleprompterResetSeq((prev) => prev + 1);
  };

  const prewarmVosk = useCallback(async () => {
    const api = (
      window as unknown as {
        electronAPI?: {
          isElectron?: boolean;
          voskModelPath?: (lang: "en" | "zh" | "it") => Promise<{ path: string; ok: boolean }>;
          voskInit?: (path: string) => Promise<{ ok: boolean; error?: string }>;
        };
      }
    ).electronAPI;
    /* Prewarm whenever IPC exists; do not require isElectron===true (some builds omit the flag). */
    if (!api?.voskModelPath || !api.voskInit || api.isElectron === false) return;
    try {
      const mp = await api.voskModelPath!(teleprompterVoskLang);
      if (!mp.ok) return;
      await api.voskInit!(mp.path);
    } catch {
      /* ignore */
    }
  }, [teleprompterVoskLang]);

  /** Prewarm on shell + language so first Follow is usually cache-hit. */
  useEffect(() => {
    void prewarmVosk();
  }, [prewarmVosk]);

  /** Opening the teleprompter panel retriggers init (no-op if already loaded) — cuts cold start if app just woke. */
  useEffect(() => {
    if (!showTeleprompter) return;
    void prewarmVosk();
  }, [showTeleprompter, prewarmVosk]);

  const handleSetTeleprompterNearCamera = (value: boolean) => {
    setTeleprompterNearCamera(value);
    if (value) setTeleprompterPosition(null);
  };

  const closeHelperByLabel = useCallback(async (label: string) => {
    if (!isElectron) return;
    try {
      const api = (window as unknown as { electronAPI?: { closeHelperByLabel: (l: string) => Promise<void> } }).electronAPI;
      await api?.closeHelperByLabel?.(label);
    } catch {
      /* ignore close errors */
    }
  }, [isElectron]);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const teleprompterChannel = new BroadcastChannel(TELEPROMPTER_CHANNEL);
    teleprompterChannelRef.current = teleprompterChannel;

    const onTeleprompterMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "teleprompter-request-state") {
        const s = teleprompterStateRef.current;
        if (s) {
          teleprompterChannel.postMessage({
            type: "teleprompter-state",
            overlayMode: "guaranteed",
            ...s,
          });
        }
      } else if (payload.type === "teleprompter-control") {
        if (typeof payload.playing === "boolean") setTeleprompterPlaying(payload.playing);
        if (typeof payload.speed === "number") setTeleprompterSpeed(Math.max(10, Math.min(80, payload.speed)));
        /* Never apply a stale/low resetSeq from a helper tab (would rewind voice-follow read position). */
        if (typeof payload.resetSeq === "number") {
          setTeleprompterResetSeq((prev) => Math.max(prev, payload.resetSeq as number));
        }
        if (typeof payload.followMode === "boolean") setTeleprompterFollowMode(payload.followMode);
        if (payload.voskLang === "en" || payload.voskLang === "zh" || payload.voskLang === "it") {
          setTeleprompterVoskLang(payload.voskLang);
        }
        if (typeof payload.width === "number") {
          setTeleprompterWidth(Math.max(320, Math.min(900, payload.width)));
        }
        if (typeof payload.height === "number") {
          setTeleprompterHeight(Math.max(180, Math.min(500, payload.height)));
        }
        if (typeof payload.locked === "boolean") setTeleprompterLocked(payload.locked);
        if (typeof payload.slimMode === "boolean") setTeleprompterSlimMode(payload.slimMode);
      } else if (payload.type === "teleprompter-close") {
        setShowTeleprompter(false);
        setTeleprompterPlaying(false);
        setTeleprompterSlimMode(false);
        teleprompterWindowRef.current = null;
        void closeHelperByLabel("teleprompter-helper");
        void closeHelperByLabel("teleprompter-slim");
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
      void closeHelperByLabel("teleprompter-slim");
      return;
    }
    if (showTeleprompter) {
      helperOpenRef.current?.("teleprompter");
    }
  }, [detachedHelpersEnabled, showTeleprompter, closeHelperByLabel]);

  /** Slim mode in Electron: own always-on-top BrowserWindow (not clipped to main webview). */
  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    const run = async () => {
      try {
        const api = (window as unknown as { electronAPI?: { openTeleprompterSlimWindow?: () => Promise<void> } }).electronAPI;
        if (showTeleprompter && teleprompterSlimMode) {
          await api?.openTeleprompterSlimWindow?.();
        } else if (!cancelled) {
          await closeHelperByLabel("teleprompter-slim");
        }
      } catch {
        /* ignore */
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isElectron, showTeleprompter, teleprompterSlimMode, closeHelperByLabel]);

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
    const state = {
      visible: showTeleprompter,
      detached: false,
      script: teleprompterScript,
      playing: teleprompterPlaying,
      speed: teleprompterSpeed,
      fontSize: teleprompterFontSize,
      opacity: teleprompterOpacity,
      width: teleprompterWidth,
      height: teleprompterHeight,
      locked: teleprompterLocked,
      resetSeq: teleprompterResetSeq,
      followMode: teleprompterFollowMode,
      voskLang: teleprompterVoskLang,
      activeScriptId: activeTeleprompterScriptId,
      slimMode: teleprompterSlimMode,
    };
    teleprompterStateRef.current = state;
    const channel = teleprompterChannelRef.current;
    if (!channel) return;
    channel.postMessage({
      type: "teleprompter-state",
      overlayMode: "guaranteed",
      ...state,
    });
  }, [
    showTeleprompter,
    teleprompterScript,
    teleprompterPlaying,
    teleprompterSpeed,
    teleprompterFontSize,
    teleprompterOpacity,
    teleprompterWidth,
    teleprompterHeight,
    teleprompterLocked,
    teleprompterResetSeq,
    teleprompterFollowMode,
    teleprompterVoskLang,
    activeTeleprompterScriptId,
    teleprompterSlimMode,
  ]);

  // Compact only when Start Recording with screen share; never on Capture Screen or Whiteboard

  const handleToggleTeleprompterLock = () => {
    setTeleprompterLocked((prev) => !prev);
  };

  // Auto-enable follow mode on recording — disabled until speech model supports CJK
  // const prevRecordingRef = useRef(false);
  // useEffect(() => {
  //   if (isRecording && !prevRecordingRef.current && showTeleprompter && teleprompterScript.trim()) {
  //     setTeleprompterFollowMode(true);
  //   }
  //   prevRecordingRef.current = isRecording;
  // }, [isRecording, showTeleprompter, teleprompterScript]);

  const cameraOverlayRef = useRef<HTMLCanvasElement>(null);
  /** Set after `drawCameraOverlay` is defined — drawComposite calls this so overlay is painted before sampling (avoids RAW fallback + border desync while dragging). */
  const drawCameraOverlayRef = useRef<(() => void) | null>(null);
  const OVERLAP_BUFFER = 60;
  /** Wider band while dragging PiP reduces portal vs composite handoff flicker near the whiteboard edge. */
  const OVERLAP_BUFFER_PIP_DRAG_EXTRA = 56;
  const avatarSizeDisplayRaw = Math.max(32, Math.round(avatarSize));
  const avatarSizeDisplay = avatarSizeDisplayRaw;
  // Size = consistent across shapes: same area for circle, portrait, landscape
  const avatarWidthDisplay =
    avatarShape === "circle"
      ? avatarSizeDisplay
      : avatarShape === "portrait"
      ? Math.round(avatarSizeDisplay * (3 / 4)) // area = size², aspect 9:16
      : Math.round(avatarSizeDisplay * (4 / 3)); // landscape: width
  const avatarHeightDisplay =
    avatarShape === "circle"
      ? avatarSizeDisplay
      : avatarShape === "portrait"
      ? Math.round(avatarSizeDisplay * (4 / 3)) // portrait: height
      : Math.round(avatarSizeDisplay * (3 / 4)); // landscape: height

  /**
   * Minimap letterbox must match `drawComposite` pipMap. Read **live** preview in memo (refs + tick deps) —
   * per-render IIFE + transient 0×0 / 1×1 fallback made `wbRecordPipOutputRect` slam the orange PiP to the corner.
   * Same `previewStable` floor as composite (`>= 50` px).
   */
  const wbRecordMinimapPipMap = useMemo(() => {
    const MIN = 50;
    const fromPreview = wbPipMapDimsFromPreviewEl(previewRef.current);
    if (fromPreview && fromPreview.pipMapW >= MIN && fromPreview.pipMapH >= MIN) {
      return fromPreview;
    }
    const live = portalRectLiveRef.current;
    const fromState = portalRect;
    const rw = fromState?.width ?? live?.width;
    const rh = fromState?.height ?? live?.height;
    let pipMapW = Math.max(1, Math.round(rw ?? wbMiniLayoutSnap.pipMapW));
    let pipMapH = Math.max(1, Math.round(rh ?? wbMiniLayoutSnap.pipMapH));
    if (pipMapW < MIN || pipMapH < MIN) {
      const prev = contentAreaPrevRectRef.current;
      if (prev && prev.w >= MIN && prev.h >= MIN) {
        pipMapW = Math.max(1, Math.round(prev.w));
        pipMapH = Math.max(1, Math.round(prev.h));
      } else {
        pipMapW = Math.max(pipMapW, 960);
        pipMapH = Math.max(pipMapH, 540);
      }
    }
    return { pipMapW, pipMapH };
  }, [
    wbMiniLayoutSnap.pipMapW,
    wbMiniLayoutSnap.pipMapH,
    wbMiniPipLayoutTick,
    portalRect,
  ]);

  const wbMiniPipMinimapUsable = useMemo(() => {
    if (!isRecording || !fullPageWhiteboard || activeScreenStream) return false;
    const aw = Math.max(8, Math.round(avatarWidthDisplay));
    const ah = Math.max(8, Math.round(avatarHeightDisplay));
    return wbRecordMinimapPipMap.pipMapW >= aw && wbRecordMinimapPipMap.pipMapH >= ah;
  }, [
    isRecording,
    fullPageWhiteboard,
    activeScreenStream,
    wbRecordMinimapPipMap.pipMapW,
    wbRecordMinimapPipMap.pipMapH,
    avatarWidthDisplay,
    avatarHeightDisplay,
  ]);

  const drawComposite = useCallback(
    (forceRecordRes = false, overrideRes?: { w: number; h: number }) => {
      const sharePctForComposite = (wbMiniShareResizeDragActiveRef.current || shareOverlayResizeDragActiveRef.current)
        ? shareWindowFillPercentRef.current
        : shareWindowFillPercent;
      const shareFillRatio = effectiveShareFillPercent(sharePctForComposite) / 100;
      const cameraVideoMain = cameraVideoRef.current;
      const cameraVideoSource = cameraSourceVideoRef.current;
      // 录制采样：全屏白板时 cameraSourceVideoRef 被摆在屏外 + opacity 0，部分浏览器几乎不更新帧，
      // 就会出现「预览有脸、成片黑圈/卡死」。门户内 cameraVideoMain 可见，解码稳定 — 白板录制优先用它。
      // Capture Screen（分享窗口）时同理：离屏 source 在 Electron 上常不解码，成片无人像；录制时优先采门户内 video。
      const forRecording = forceRecordRes || isRecording;
      const skipCameraOnRecord =
        omitPipFromRecording && forceRecordRes && !recordingSessionIncludePipRef.current;
      const videoUsable = (v: typeof cameraVideoMain) =>
        v && v.readyState >= 2 && v.videoWidth > 0 ? v : null;
      const wbPreferPortalCam = fullPageWhiteboard && !activeScreenStream;
      const wbScreenShare = fullPageWhiteboard && activeScreenStream;
      const cameraVideo =
        forRecording && wbPreferPortalCam
          ? videoUsable(cameraVideoMain) ??
            videoUsable(cameraVideoSource) ??
            cameraVideoMain ??
            cameraVideoSource
          : forRecording && wbScreenShare
            ? videoUsable(cameraVideoMain) ??
              videoUsable(cameraVideoSource) ??
              cameraVideoMain ??
              cameraVideoSource
            : (forRecording && videoUsable(cameraVideoSource) ? cameraVideoSource : null) ??
              videoUsable(cameraVideoMain) ??
              videoUsable(cameraVideoSource) ??
              cameraVideoMain ??
              cameraVideoSource;
      const pip = pipRef.current;
      const avatarImg = avatarImgRef.current;
      const preview =
        previewRef.current ??
        (fullPageWhiteboard && !activeScreenStream ? contentAreaRef.current : null);
      const composite =
        (forceRecordRes && recordingCanvasRef.current) || compositeRef.current;
      if (!preview || !composite) return;
      /** PiP x/y must use the **on-screen** capture canvas + its client size — never the off-DOM recording canvas (rect 0×0 → no PiP in export). */
      const captureLayoutEl =
        activeScreenStream && compositeRef.current ? compositeRef.current : preview;
      // Full-page whiteboard without screen: composite <canvas> stays invisible (PiP is a portal). Skip idle
      // repainting — was burning ~2× content-area pixels @ DPR per frame and starving Excalidraw + drag.
      if (!forceRecordRes && !isRecording && fullPageWhiteboard && !activeScreenStream) {
        return;
      }

      const res: { w: number; h: number } =
        (forceRecordRes && overrideRes) || recordOutputDimensions;
      const useRecordRes = forceRecordRes || isRecordingRef.current;

      let prevW = preview.offsetWidth;
      let prevH = preview.offsetHeight;
      const wbSnap = recordWhiteboardPreviewSizeRef.current;
      const wbOnlyRecording = forceRecordRes && fullPageWhiteboard && !activeScreenStream;
      if (activeScreenStream) {
        const paneLock = shareInteractionPaneLockRef.current;
        if (paneLock && paneLock.w > 0 && paneLock.h > 0) {
          prevW = paneLock.w;
          prevH = paneLock.h;
        } else {
        // Size from the capture **pane** (`preview`), not `compositeRef`. We set canvas inline width/height each
        // frame; reading composite.clientWidth created a feedback loop after window resize (stale size → black
        // margins showing the pane's bg-slate-900). PiP math still uses `captureLayoutEl.getBoundingClientRect()`.
        const r = preview.getBoundingClientRect();
        const rawW = quantizeCapturePanePx(r.width);
        const rawH = quantizeCapturePanePx(r.height);
        const st = screenSharePaneStableRef.current;
        const shareDragging = !!sharePortraitPanDragRef.current;
        const freezePaneSize =
          (shareOverlayResizeDragActiveRef.current || shareDragging) &&
          !!st &&
          st.w > 0 &&
          st.h > 0;
        if (!freezePaneSize && (
          !st ||
          Math.abs(rawW - st.w) >= SCREEN_SHARE_PANE_DEADBAND_PX ||
          Math.abs(rawH - st.h) >= SCREEN_SHARE_PANE_DEADBAND_PX
        )) {
          screenSharePaneStableRef.current = { w: rawW, h: rawH };
        }
        prevW = screenSharePaneStableRef.current!.w;
        prevH = screenSharePaneStableRef.current!.h;
        }
      } else if (wbOnlyRecording) {
        // Match on-screen CSS box (Mac/non-16:9): frozen wbSnap can be smaller than real layout → PiP scales up in export.
        const pr = preview.getBoundingClientRect();
        prevW = Math.max(1, Math.round(pr.width));
        prevH = Math.max(1, Math.round(pr.height));
      } else if (forceRecordRes && wbSnap) {
        prevW = Math.max(prevW || 0, wbSnap.w);
        prevH = Math.max(prevH || 0, wbSnap.h);
      }
      if ((prevW <= 0 || prevH <= 0) && useRecordRes) {
        prevW = res.w;
        prevH = res.h;
      }
      if (prevW <= 0 || prevH <= 0) return;
      // Skip camera during layout transition when preview is collapsed (avoids wrong scale/position)
      const previewStable = prevW >= 50 && prevH >= 50;
      const dpr = useRecordRes
        ? Math.min(2, window.devicePixelRatio || 1)
        : Math.min(1.33, window.devicePixelRatio || 1);
      let w: number;
      let h: number;
      if (useRecordRes) {
        w = res.w;
        h = res.h;
      } else if (activeScreenStream) {
        if (isPortraitRecordOutputShape(recordOutputShape)) {
          const od = getRecordOutputDimensions(recordResolution, recordOutputShape);
          const fitPane = fitRectWithAspectInside(prevW, prevH, od.w, od.h);
          w = Math.max(1, Math.round(fitPane.w * dpr));
          h = Math.max(1, Math.round(fitPane.h * dpr));
        } else {
          w = Math.max(1, Math.round(prevW * dpr));
          // One dimension from DPR, the other from aspect — independent rounding on w and h made scaleX ≠ scaleY
          // during live window resize and skewed the PiP (oval) + composite sampling.
          h = Math.max(1, Math.round((w * prevH) / prevW));
        }
      } else {
        w = Math.max(1, Math.round(prevW * dpr));
        h = Math.max(1, Math.round((w * prevH) / prevW));
      }
      const scaleX = w / prevW;
      if (composite.width !== w || composite.height !== h) {
        composite.width = w;
        composite.height = h;
      }
      // For live screen share preview, canvas is absolutely positioned with `h-full w-full`;
      // writing pixel CSS sizes each frame can cause layout micro-jitter (visible as shake in capture).
      if (!activeScreenStream || useRecordRes) {
        const sw = `${prevW}px`;
        const sh = `${prevH}px`;
        if (composite.style.width !== sw) composite.style.width = sw;
        if (composite.style.height !== sh) composite.style.height = sh;
      } else if (isPortraitRecordOutputShape(recordOutputShape)) {
        const od = getRecordOutputDimensions(recordResolution, recordOutputShape);
        const fitPane = fitRectWithAspectInside(prevW, prevH, od.w, od.h);
        const sw = `${Math.round(fitPane.w)}px`;
        const sh = `${Math.round(fitPane.h)}px`;
        if (composite.style.width !== sw) composite.style.width = sw;
        if (composite.style.height !== sh) composite.style.height = sh;
      } else {
        /** Landscape live preview: must overwrite prior portrait `fitPane` inline sizes or a tall mat stays inside a wide pane. */
        const sw = `${prevW}px`;
        const sh = `${prevH}px`;
        if (composite.style.width !== sw) composite.style.width = sw;
        if (composite.style.height !== sh) composite.style.height = sh;
      }
      const ctx = composite.getContext("2d", { alpha: false });
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      // Screen-share frames are already sharp at source; "high" scales cost GPU time and can add jank with 4K capture + PiP.
      ctx.imageSmoothingQuality =
        useRecordRes && activeScreenStream ? "medium" : useRecordRes ? "high" : "medium";
      ctx.clearRect(0, 0, w, h);
      const screenVisible = screenVideoRef.current;
      const usableScreenVideo = (v: HTMLVideoElement | null) =>
        v && v.srcObject && v.readyState >= 2 && v.videoWidth > 0 ? v : null;
      const videoForDraw =
        activeScreenStream
          ? usableScreenVideo(screenVisible) ?? screenVisible
          : null;

      if (useRecordRes && activeScreenStream && isDreamworkCaptureDebugEnabled()) {
        if (videoForDraw?.srcObject && videoForDraw.readyState >= 2) {
          captureDebugScreenHitRef.current += 1;
        } else {
          captureDebugScreenMissRef.current += 1;
        }
      }

      if (videoForDraw?.srcObject && videoForDraw.readyState >= 2) {
        drawLetterboxBg(ctx, letterboxBackground, w, h, letterboxCustomImgRef.current, letterboxMode);
        let sw0 = Math.max(1, videoForDraw.videoWidth || w);
        let sh0 = Math.max(1, videoForDraw.videoHeight || h);
        if (activeScreenStream) {
          const vt = activeScreenStream.getVideoTracks()[0];
          const tid = vt?.id ?? "";
          const prevI = screenShareStableIntrinsicRef.current;
          if (!prevI || tid !== screenShareIntrinsicTrackIdRef.current) {
            screenShareStableIntrinsicRef.current = { sw: sw0, sh: sh0 };
            screenShareIntrinsicTrackIdRef.current = tid;
          } else if (
            Math.abs(sw0 - prevI.sw) > SCREEN_SHARE_INTRINSIC_JITTER_EPS_PX ||
            Math.abs(sh0 - prevI.sh) > SCREEN_SHARE_INTRINSIC_JITTER_EPS_PX
          ) {
            screenShareStableIntrinsicRef.current = { sw: sw0, sh: sh0 };
          }
          const locked = screenShareStableIntrinsicRef.current;
          if (locked) {
            sw0 = locked.sw;
            sh0 = locked.sh;
          }
        }
        /** Share window: uniform scale (contain) inside the frame — split-view preview used to stretch to the cell and looked squashed while resizing; recording already used contain. */
        const screenShareDrawContained = activeScreenStream;
        let trimmed: { sx: number; sy: number; sw: number; sh: number };
        if (activeScreenStream) {
          const screenVTrack = activeScreenStream.getVideoTracks()[0];
          if (shouldSkipMacOSPaddingTrimForDisplaySurface(screenVTrack)) {
            trimmed = { sx: 0, sy: 0, sw: sw0, sh: sh0 };
          } else {
            const key = `${sw0}x${sh0}`;
            const shareInteractionDragging = !!sharePortraitPanDragRef.current;
            screenTrimFrameRef.current += 1;
            const cached = screenTrimCacheRef.current;
            if (shareInteractionDragging && cached) {
              trimmed = cached.rect;
            } else if (cached?.key === key && screenTrimFrameRef.current % SCREEN_TRIM_REFRESH_FRAMES !== 0) {
              trimmed = cached.rect;
            } else {
              const raw = trimMacOSScreenSharePadding(videoForDraw, sw0, sh0);
              let next = snapScreenTrimRect(raw, sw0, sh0);
              if (cached?.key === key) {
                next = mergeStableScreenTrim(cached.rect, next);
              }
              screenTrimCacheRef.current = { key, rect: next };
              trimmed = next;
            }
          }
        } else {
          trimmed = { sx: 0, sy: 0, sw: sw0, sh: sh0 };
        }
        const { sx, sy, sw, sh } = trimmed;
        /** Clamped intrinsic crop rect (single aspect for layout + drawImage src). */
        const awVid = Math.max(1, videoForDraw.videoWidth || 1);
        const ahVid = Math.max(1, videoForDraw.videoHeight || 1);
        let sxcDraw = sx;
        let sycDraw = sy;
        let swcDraw = Math.min(sw, Math.max(0, awVid - sxcDraw));
        let shcDraw = Math.min(sh, Math.max(0, ahVid - sycDraw));
        let dw: number;
        let dh: number;
        let dx: number;
        let dy: number;
        if (activeScreenStream) {
          /** Share rect = contain intrinsic source inside maxW×maxH — preserve window aspect (no portrait-box stretch feel); gutters stay as letterbox background. */
          const maxW = Math.round(w * shareFillRatio);
          const maxH = Math.round(h * shareFillRatio);
          const scaleContain = Math.min(
            maxW / Math.max(1, swcDraw),
            maxH / Math.max(1, shcDraw)
          );
          dw = Math.max(1, Math.round(swcDraw * scaleContain));
          dh = Math.max(1, Math.round(shcDraw * scaleContain));
          const slackX = w - dw;
          const slackY = h - dh;
          const pan = sharePortraitPanNormRef.current;
          dx = Math.round((slackX * (pan.x + 1)) / 2);
          dy = Math.round((slackY * (pan.y + 1)) / 2);
        } else {
          const useCrop = letterboxMode === "crop";
          const useFill = letterboxMode === "fill";
          if (useFill) {
            dw = w;
            dh = h;
            dx = 0;
            dy = 0;
          } else {
            const scale = useCrop ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
            dw = sw * scale;
            dh = sh * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
          }
        }
        let screenContentRad = 0;
        if (screenShareDrawContained) {
          screenContentRad = useRecordRes
            ? Math.min(SHARE_WINDOW_CORNER_RADIUS_OUT_PX, dw / 2, dh / 2)
            : Math.min(SHARE_WINDOW_CORNER_RADIUS_OUT_PX * scaleX, dw / 2, dh / 2);
          const skipShareDestJitter =
            !useRecordRes && !!activeScreenStream && !!sharePortraitPanDragRef.current;
          /** Live preview only: draggable pan replaces trim-based position jitter while screen-sharing. */
          let ddx = dx;
          let ddy = dy;
          let ddw = dw;
          let ddh = dh;
          if (!useRecordRes) {
            const trimKey = `${sx},${sy},${sw},${sh}`;
            const prevDest = screenShareDrawDestRef.current;
            const JITTER_EPS = SCREEN_SHARE_DEST_JITTER_EPS_PX;
            if (
              !skipShareDestJitter &&
              prevDest &&
              prevDest.trimKey === trimKey &&
              Math.abs(ddx - prevDest.tx) <= JITTER_EPS &&
              Math.abs(ddy - prevDest.ty) <= JITTER_EPS &&
              Math.abs(ddw - prevDest.tw) <= JITTER_EPS &&
              Math.abs(ddh - prevDest.th) <= JITTER_EPS
            ) {
              ddx = prevDest.tx;
              ddy = prevDest.ty;
              ddw = prevDest.tw;
              ddh = prevDest.th;
            } else {
              screenShareDrawDestRef.current = { trimKey, tx: ddx, ty: ddy, tw: ddw, th: ddh };
            }
          }
          if (activeScreenStream) {
            const layout = { w, h, dw: ddw, dh: ddh, dx: ddx, dy: ddy };
            sharePanLayoutRef.current = layout;
            applySharePanOverlayDom(layout);
          }
          ctx.save();
          ctx.beginPath();
          roundRectPath(ctx, ddx, ddy, ddw, ddh, screenContentRad);
          ctx.clip();
          ctx.drawImage(videoForDraw, sxcDraw, sycDraw, swcDraw, shcDraw, ddx, ddy, ddw, ddh);
          ctx.restore();
          ctx.beginPath();
          roundRectPath(ctx, ddx, ddy, ddw, ddh, screenContentRad);
          ctx.strokeStyle = "#000000";
          ctx.lineJoin = "round";
          ctx.lineWidth = useRecordRes
            ? SHARE_WINDOW_BORDER_OUT_PX
            : SHARE_WINDOW_BORDER_OUT_PX * scaleX;
          ctx.stroke();
        } else {
          if (activeScreenStream) {
            const layout = { w, h, dw, dh, dx, dy };
            sharePanLayoutRef.current = layout;
            applySharePanOverlayDom(layout);
          }
          ctx.drawImage(videoForDraw, sx, sy, sw, sh, dx, dy, dw, dh);
        }
      } else if ((useRecordRes || fullPageWhiteboard) && fullPageWhiteboard && !activeScreenStream) {
        drawLetterboxBg(ctx, letterboxBackground, w, h, letterboxCustomImgRef.current, letterboxMode);
        const contentEl = contentAreaRef.current;
        const contentW = Math.max(1, contentEl?.offsetWidth ?? prevW);
        const whiteboardOnlyRecord = forceRecordRes && !activeScreenStream;
        const handleZonePx = 14;
        const miniW = Math.round(w * (40 / contentW));
        const wbEl = fullPageContentRef.current;
        const wbCssW = Math.max(1, wbEl?.offsetWidth ?? prevW);
        const wbCssH = Math.max(1, wbEl?.offsetHeight ?? prevH);
        let liveComposite: HTMLCanvasElement | null = null;
        if (forRecording && wbEl) {
          if (!wbLiveCompositeCanvasRef.current) wbLiveCompositeCanvasRef.current = document.createElement("canvas");
          liveComposite = compositeExcalidrawViewportCanvases(wbEl, wbCssW, wbCssH, wbLiveCompositeCanvasRef.current);
          if (liveComposite) {
            const lctx = liveComposite.getContext("2d");
            if (lctx) drawEditingTextOverlaySync(lctx, wbEl, wbCssW, wbCssH, liveComposite.width, liveComposite.height);
          }
        }
        const whiteboardExported = whiteboardExportedRef.current;
        const whiteboardLayers = whiteboardCanvasLayersRef.current.filter((layer) => layer.width > 0 && layer.height > 0);
        const mainLayer = whiteboardLayers.length > 0
          ? whiteboardLayers.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
          : null;
        const exportedOk =
          !!whiteboardExported && whiteboardExported.width > 0 && whiteboardExported.height > 0;
        const liveOk = !!liveComposite && liveComposite.width > 0 && liveComposite.height > 0;
        /** Intrinsic board size for record layout (same fill as screen capture). */
        let iw = Math.max(1, wbSnap?.w ?? prevW);
        let ih = Math.max(1, wbSnap?.h ?? prevH);
        if (liveOk && liveComposite) {
          iw = liveComposite.width;
          ih = liveComposite.height;
        } else if (exportedOk && whiteboardExported) {
          iw = whiteboardExported.width;
          ih = whiteboardExported.height;
        } else if (mainLayer) {
          iw = mainLayer.width;
          ih = mainLayer.height;
        }
        let whiteboardSurfaceW: number;
        let whiteboardSurfaceH: number;
        let whiteboardX: number;
        let whiteboardY: number;
        if (whiteboardOnlyRecord) {
          const surf = computeWhiteboardRecordingSurfacePx(
            w,
            h,
            iw,
            ih,
            shareFillRatio,
            whiteboardRecordSurfacePanNorm
          );
          whiteboardSurfaceW = surf.w;
          whiteboardSurfaceH = surf.h;
          whiteboardX = surf.x;
          whiteboardY = surf.y;
          wbRecordingIwihRef.current = { iw, ih };
        } else {
          whiteboardSurfaceW = w - miniW - handleZonePx;
          whiteboardSurfaceH = h;
          whiteboardX = 0;
          whiteboardY = 0;
        }
        const rad = Math.min(
          AVATAR_RECT_RADIUS * scaleX,
          whiteboardSurfaceW / 2,
          whiteboardSurfaceH / 2
        );
        ctx.save();
        roundRectPath(ctx, whiteboardX, whiteboardY, whiteboardSurfaceW, whiteboardSurfaceH, rad);
        ctx.clip();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(whiteboardX, whiteboardY, whiteboardSurfaceW, whiteboardSurfaceH);
        const texImg = whiteboardTextureImgRef.current;
        if (texImg?.complete && texImg.naturalWidth > 0) {
          const tscale = Math.max(whiteboardSurfaceW / texImg.naturalWidth, whiteboardSurfaceH / texImg.naturalHeight);
          const tw = texImg.naturalWidth * tscale;
          const th = texImg.naturalHeight * tscale;
          ctx.drawImage(texImg, whiteboardX + (whiteboardSurfaceW - tw) / 2, whiteboardY + (whiteboardSurfaceH - th) / 2, tw, th);
        } else {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(whiteboardX, whiteboardY, whiteboardSurfaceW, whiteboardSurfaceH);
        }
        const drawWbSrc = (src: HTMLCanvasElement) => {
          const lw = src.width;
          const lh = src.height;
          if (lw <= 0 || lh <= 0) return false;
          const lscale = Math.min(whiteboardSurfaceW / lw, whiteboardSurfaceH / lh);
          const ldw = lw * lscale;
          const ldh = lh * lscale;
          const ldx = whiteboardX + (whiteboardSurfaceW - ldw) / 2;
          const ldy = whiteboardY + (whiteboardSurfaceH - ldh) / 2;
          try {
            ctx.drawImage(src, 0, 0, lw, lh, ldx, ldy, ldw, ldh);
            return true;
          } catch {
            return false;
          }
        };
        if (liveOk && liveComposite) {
          if (!drawWbSrc(liveComposite) && exportedOk && whiteboardExported) drawWbSrc(whiteboardExported);
        } else if (exportedOk && whiteboardExported) {
          if (!drawWbSrc(whiteboardExported) && mainLayer) drawWbSrc(mainLayer);
        } else if (mainLayer) {
          drawWbSrc(mainLayer);
        }
        ctx.restore();
        if (whiteboardOnlyRecord) {
          ctx.strokeStyle = "#000000";
          ctx.lineWidth = 3;
          roundRectPath(ctx, whiteboardX, whiteboardY, whiteboardSurfaceW, whiteboardSurfaceH, rad);
          ctx.stroke();
        }
        if (!whiteboardOnlyRecord) {
          ctx.fillStyle = "#e8eeff";
          ctx.fillRect(whiteboardSurfaceW, 0, handleZonePx, h);
          ctx.fillStyle = "#1e293b";
          const barX = whiteboardSurfaceW + handleZonePx;
          const barRad = Math.min(rad, miniW / 2, h / 2);
          roundRectPath(ctx, barX, 0, miniW, h, barRad);
          ctx.fill();
        }
      } else if (useRecordRes || (fullPageWhiteboard && !activeScreenStream)) {
        drawLetterboxBg(ctx, letterboxBackground, w, h, letterboxCustomImgRef.current, letterboxMode);
      }

      // Always composite for recording and in-app capture preview.
      // Detached helper only controls desktop overlay UX, not in-app preview effects.
      const shouldCompositeCamera =
        forceRecordRes || !detachedHelpersEnabled || (!fullPageWhiteboard && !!activeScreenStream);
      const useAvatarImage = shouldCompositeCamera && showPip && !!avatarImageSrc && avatarImg?.complete;
      const videoDrawableForComposite =
        !!cameraVideo &&
        !!cameraVideo.srcObject &&
        (cameraVideo.readyState >= 2 ||
          (!!forceRecordRes && cameraVideo.readyState >= 1 && cameraVideo.videoWidth > 0));
      const useCamera =
        shouldCompositeCamera && showPip && !useAvatarImage && videoDrawableForComposite;

      /** Mirror recording uses whichever element has a decoded frame — avoids flapping when source video hiccups. */
      const camMain = cameraVideoMain;
      const camSrc = cameraVideoSource;
      const camPick = (v: typeof camMain) =>
        v?.srcObject && v.readyState >= 2 && v.videoWidth > 0 ? v : null;
      const camPickLoose = (v: typeof camMain) =>
        v?.srcObject && v.readyState >= 2 ? v : null;
      /** 录制/导出单帧时 HAVE_CURRENT_DATA 即可尝试采样，避免首几帧 readyState 未到 2 导致 cache 永远空、成片无人像 */
      const camPickRecording = (v: typeof camMain) =>
        v?.srcObject && v.readyState >= 1 && v.videoWidth > 0 ? v : null;
      const samplePortalFirst = wbPreferPortalCam || (wbScreenShare && forRecording);
      const camToSample =
        shouldCompositeCamera && showPip && !useAvatarImage
          ? (samplePortalFirst
              ? camPick(camMain) ??
                camPick(camSrc) ??
                camPickRecording(camMain) ??
                camPickRecording(camSrc) ??
                camPickLoose(camMain) ??
                camPickLoose(camSrc)
              : camPick(camSrc) ??
                camPick(camMain) ??
                camPickRecording(camSrc) ??
                camPickRecording(camMain) ??
                camPickLoose(camSrc) ??
                camPickLoose(camMain))
          : null;
      if (
        !wbOnlyRecording &&
        camToSample &&
        camToSample.videoWidth > 0 &&
        camToSample.videoHeight > 0
      ) {
        const existingCache = lastCameraFrameCanvasRef.current;
        const throttleCamCache =
          !!forceRecordRes &&
          !!activeScreenStream &&
          !!existingCache &&
          existingCache.width === camToSample.videoWidth &&
          existingCache.height === camToSample.videoHeight;
        screenRecCamCacheTickRef.current += 1;
        const skipCamCacheFill = throttleCamCache && screenRecCamCacheTickRef.current % 2 === 0;
        if (!skipCamCacheFill) {
          let cache = existingCache;
          if (!cache) {
            cache = document.createElement("canvas");
            lastCameraFrameCanvasRef.current = cache;
          }
          if (cache.width !== camToSample.videoWidth || cache.height !== camToSample.videoHeight) {
            cache.width = camToSample.videoWidth;
            cache.height = camToSample.videoHeight;
          }
          const cacheCtx = cache.getContext("2d");
          if (cacheCtx) {
            cacheCtx.save();
            cacheCtx.translate(cache.width, 0);
            cacheCtx.scale(-1, 1);
            cacheCtx.translate(-cache.width, 0);
            cacheCtx.drawImage(camToSample, 0, 0, cache.width, cache.height);
            cacheCtx.restore();
          }
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
        !whiteboardRecording &&
        (draggingDuringScreenRecord || !useCamera);
      /** 先同步画门户 overlay，再读像素；否则 canvas 可能仍为 0×0，pipSource 会退化成 raw video（拖拽时闪 RAW、描边与内容不同步）。 */
      if (useRecordRes && wbPreferPortalCam && showPip && !avatarImageSrc && !skipCameraOnRecord) {
        drawCameraOverlayRef.current?.();
      }
      /** 白板录制：无可用 overlay 时才采门户 video（与 wbRecordFromPortalOverlay 互斥，避免 RAW / 处理画面交替）。 */
      const overlayPip = cameraOverlayRef.current;
      const wbRecordFromPortalOverlay =
        forceRecordRes &&
        wbPreferPortalCam &&
        !useAvatarImage &&
        !activeScreenStream &&
        !avatarImageSrc &&
        !!overlayPip &&
        overlayPip.width > 0 &&
        overlayPip.height > 0;
      const wbRecordLiveVideo =
        forceRecordRes &&
        wbPreferPortalCam &&
        !useAvatarImage &&
        !!cameraVideo?.srcObject &&
        cameraVideo.readyState >= 1 &&
        cameraVideo.videoWidth > 0 &&
        !wbRecordFromPortalOverlay;
      let pipSource: CanvasImageSource | null = useAvatarImage
        ? avatarImg
        : wbRecordFromPortalOverlay
          ? overlayPip
          : wbRecordLiveVideo
            ? cameraVideo
            : useCamera
              ? cameraVideo
              : forceRecordRes && hasCached && !useAvatarImage
                ? cachedCameraCanvas
                : useCachedCamera
                  ? cachedCameraCanvas
                  : null;
      /** Capture Screen 录制：wbRecordLiveVideo 只在无屏幕分享时为真，外层 if 曾把 useCamera 为 false 时整段丢弃 → 成片无人像。 */
      if (
        !pipSource &&
        forceRecordRes &&
        wbScreenShare &&
        showPip &&
        !skipCameraOnRecord &&
        !useAvatarImage
      ) {
        const v =
          videoUsable(cameraVideoMain) ??
          videoUsable(cameraVideoSource) ??
          (cameraVideoMain?.srcObject ? cameraVideoMain : null) ??
          (cameraVideoSource?.srcObject ? cameraVideoSource : null);
        if (v) pipSource = v;
      }
      if (
        !skipCameraOnRecord &&
        previewStable &&
        pipSource &&
        (useAvatarImage ||
          useCamera ||
          useCachedCamera ||
          wbRecordLiveVideo ||
          wbRecordFromPortalOverlay ||
          (forceRecordRes && wbScreenShare && !useAvatarImage))
      ) {
        const prevRect = captureLayoutEl.getBoundingClientRect();
        /**
         * Map portal / preview CSS box → output pixels. Must use the **same** box as `prevRect`
         * (usually `compositeRef`'s on-screen size). Recording + portrait fits the composite to
         * `dispW×dispH` inside the pane while `prevW/prevH` still describe the full column — using
         * `w/prevW` here squashes PiP into a thin strip and misaligns drag vs paint.
         */
        const pipMapW = Math.max(1, Math.round(prevRect.width));
        const pipMapH = Math.max(1, Math.round(prevRect.height));
        /** Independent scales map preview px → output px when aspects differ — squashes PiP if used for width & height separately. */
        const pipScaleXRaw = w / pipMapW;
        const pipScaleYRaw = h / pipMapH;
        /**
         * Full-page WB + record: preview is ultra-wide (`contentArea`) while portrait output is tall —
         * uniform scale preserves PiP aspect; offsets match wbRecordPipOutputRect / layout minimap.
         */
        const wbPipUniformEncode =
          forceRecordRes && fullPageWhiteboard && !activeScreenStream;
        const pipDecorScale = Math.min(pipScaleXRaw, pipScaleYRaw);
        let x: number;
        let y: number;
        let pw: number;
        let ph: number;
        let shouldDraw = true;
        // Match fullPagePipForRender: ref while dragging or wb-only recording; else state (screen share + recording used ref-only before — caused composite/portal desync).
        const wbOnlyRecUi = fullPageWhiteboard && !activeScreenStream;
        const fallbackPos = fullPageWhiteboard
          ? pipDraggingRef.current ||
              wbMiniPipDraggingRef.current ||
              ((forceRecordRes || isRecordingRef.current) && wbOnlyRecUi) ||
              (forceRecordRes && activeScreenStream)
            ? fullPagePipPosRef.current
            : fullPagePipPos
          : pipDraggingRef.current
            ? pipPosRef.current
            : pipPos;
        const fallbackLeft =
          fullPageWhiteboard && activeScreenStream
            ? fallbackPos.x + CAMERA_OFFSET
            : prevRect.left + fallbackPos.x;
        const fallbackTop =
          fullPageWhiteboard && activeScreenStream
            ? fallbackPos.y + CAMERA_OFFSET
            : prevRect.top + fallbackPos.y;
        // Ref tracks drag + recording; getBoundingClientRect can lag direct style updates.
        // Minimap amber drag never sets pipDraggingRef — must still avoid DOM rect (stroke/video desync in export).
        // drawComposite(false) during WB recording must use ref+math like drawComposite(true), not stale state/Rect.
        const useFallbackForComposite =
          !!pipDraggingRef.current ||
          !!wbMiniPipDraggingRef.current ||
          (fullPageWhiteboard && activeScreenStream) ||
          ((forceRecordRes || isRecordingRef.current) && fullPageWhiteboard && !activeScreenStream);
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
        const pipWPreview = forceRecordRes ? avatarWidthDisplay : rect.width;
        const pipHPreview = forceRecordRes ? avatarHeightDisplay : rect.height;
        const pipOffX = rect.left - prevRect.left;
        const pipOffY = rect.top - prevRect.top;
        if (wbPipUniformEncode) {
          const rp = wbRecordPipOutputRect({
            outW: w,
            outH: h,
            pipMapW,
            pipMapH,
            pipX: pipOffX,
            pipY: pipOffY,
            pipWCss: pipWPreview,
            pipHCss: pipHPreview,
          });
          x = rp.x;
          y = rp.y;
          pw = rp.pw;
          ph = rp.ph;
        } else {
          x = Math.round(pipOffX * pipScaleXRaw);
          y = Math.round(pipOffY * pipScaleYRaw);
          pw = Math.round(pipWPreview * pipScaleXRaw);
          ph = Math.round(pipHPreview * pipScaleYRaw);
        }
        const buf = 24;
        const pipWellInsidePreview =
          rect.left >= prevRect.left + buf &&
          rect.right <= prevRect.right - buf &&
          rect.top >= prevRect.top + buf &&
          rect.bottom <= prevRect.bottom - buf;
        if (!pipWellInsidePreview && fullPageWhiteboard && activeScreenStream && !forceRecordRes) {
          shouldDraw = false;
        } else {
          const recordingWithScreen = forceRecordRes && activeScreenStream;
          if (!recordingWithScreen) {
            x = Math.max(0, Math.min(x, w - pw));
            y = Math.max(0, Math.min(y, h - ph));
          }
        }
        // Full-page WB + screen share: preview PiP is only the fixed portal (one bubble). Painting the
        // camera into composite here as well doubles PiP and can blink (composite ~30fps vs portal).
        // While recording: draw PiP on composite only when it overlaps the capture rect; if parked on the
        // whiteboard column, skip composite and show the portal so the user still sees the bubble.
        const wbScreenPortalOnlyPreview = fullPageWhiteboard && activeScreenStream;
        let drawCameraToCanvas = wbScreenPortalOnlyPreview
          ? !!forceRecordRes
          : forceRecordRes || !shouldCompositeCamera;
        if (wbScreenPortalOnlyPreview && forceRecordRes) {
          const inCaptureColumn = capturePipInColumnRef.current;
          drawCameraToCanvas = inCaptureColumn;
          screenRecPipCompositeStickyRef.current = inCaptureColumn;
          if (drawCameraToCanvas) {
            x = Math.min(Math.max(x, 0), Math.max(0, w - pw));
            y = Math.min(Math.max(y, 0), Math.max(0, h - ph));
          }
          /**
           * Recording canvas (`forceRecordRes`) is off-DOM; mutating portal visibility every encoded frame
           * creates high-frequency UI flicker while dragging share window. Keep preview PiP DOM untouched.
           */
        } else if (wbScreenPortalOnlyPreview) {
          const pipEl = pipRef.current;
          const pipVis = pipPortalVisualRef.current;
          if (pipEl && pipVis && !isRecordingRef.current) {
            pipVis.style.visibility = "visible";
            pipEl.style.backgroundColor = "#000000";
          }
        }
        if (shouldDraw && drawCameraToCanvas) {
        const isCircle = avatarShape === "circle";

      ctx.save();
      ctx.beginPath();
      if (isCircle) {
        const cx = x + pw / 2;
        const cy = y + ph / 2;
        const r = Math.min(pw, ph) / 2;
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      } else {
        roundRectPath(ctx, x, y, pw, ph, Math.min(AVATAR_RECT_RADIUS * pipDecorScale, Math.min(pw, ph) / 2));
      }
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, pw, ph);
      /** Source is portal overlay canvas — decor stroke already painted inside the bitmap (see drawCameraOverlay). Do not key off wbRecordFromPortalOverlay alone: it requires forceRecordRes and was false for drawComposite() sans arg, causing video+composite stroke to alternate with overlay → double border / ghost in export. */
      const pipIsPortalOverlay =
        pipSource instanceof HTMLCanvasElement && pipSource === overlayPip;
      if (beautyMode && !pipIsPortalOverlay) ctx.filter = beautySettingsToFilter(beautySettings);
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
            : pipSource instanceof HTMLCanvasElement
              ? pipSource.width
              : (pipSource as HTMLImageElement).naturalWidth || pw;
        const vh =
          pipSource instanceof HTMLVideoElement
            ? pipSource.videoHeight || ph
            : pipSource instanceof HTMLCanvasElement
              ? pipSource.height
              : (pipSource as HTMLImageElement).naturalHeight || ph;
        const rel = pipScaleForVideo(pw, ph, vw, vh);
        const drawW = rel.drawW;
        const drawH = rel.drawH;
        const dx = x + rel.dx;
        const dy = y + rel.dy;
        const mirrorPipLikeVideo =
          pipSource instanceof HTMLVideoElement ||
          (pipSource instanceof HTMLCanvasElement && pipSource === overlayPip);
        if (mirrorPipLikeVideo) {
          ctx.save();
          ctx.translate(dx + drawW, dy);
          ctx.scale(-1, 1);
          ctx.translate(-dx, -dy);
          ctx.drawImage(pipSource, 0, 0, vw, vh, dx, dy, drawW, drawH);
          ctx.restore();
        } else {
          ctx.drawImage(pipSource, 0, 0, vw, vh, dx, dy, drawW, drawH);
        }
        if (
          pipEffectBackend === "mediapipe" &&
          faceFilter !== "none" &&
          !useAvatarImage &&
          !pipIsPortalOverlay
        ) {
          try {
            const lm =
              faceLandmarksRef.current ??
              (performance.now() - lastValidLandmarksAtRef.current < LANDMARK_PERSIST_MS
                ? lastValidLandmarksRef.current
                : null);
            const nowMs = performance.now();
            ctx.filter = "none";
            drawFaceFilter(ctx, lm, faceFilter, dx, dy, drawW, drawH, true, nowMs);
          } catch {
            /* face filter may fail if landmarks invalid */
          }
        }
      }
      ctx.restore();

      // Portal overlay already includes decor stroke; drawing again here doubles borders (laggy / overlapping look).
      if (!pipIsPortalOverlay) {
        // Draw stroke: for simple/glow, draw white undercoat first to eliminate black edge from clip antialias.
        // Skip undercoat for dashed - it obscures the dash pattern (gaps show solid white underneath).
        ctx.save();
        ctx.beginPath();
        if (isCircle) {
          const cx = x + pw / 2;
          const cy = y + ph / 2;
          const r = Math.min(pw, ph) / 2;
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
        } else {
          roundRectPath(ctx, x, y, pw, ph, Math.min(AVATAR_RECT_RADIUS * pipDecorScale, Math.min(pw, ph) / 2));
        }
        const strokeScale = pipDecorScale;
        if (avatarDecor !== "none" && avatarDecor !== "dashed") {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 5 * strokeScale;
          ctx.setLineDash([]);
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          ctx.stroke();
        }
        const strokePx = avatarDecor === "dashed" ? 2 : avatarDecor === "simple" ? 2 : avatarDecor === "none" ? 2 : 3;
        ctx.strokeStyle = avatarDecor === "none" ? "#000" : "rgba(255,255,255,0.95)";
        ctx.lineWidth = strokePx * strokeScale;
        if (avatarDecor === "dashed") ctx.setLineDash([8 * strokeScale, 4 * strokeScale]);
        else ctx.setLineDash([]);
        const suppressGlowTrail =
          (pipDraggingRef.current || wbMiniPipDraggingRef.current) &&
          forceRecordRes &&
          (activeScreenStream || fullPageWhiteboard);
        if (avatarDecor === "glow" && !suppressGlowTrail) {
          ctx.shadowColor = hexToRgba(glowColor, 0.85);
          ctx.shadowBlur = 48;
        } else {
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
        }
        ctx.stroke();
        ctx.restore();
      }
        }
    }
      // When black border (none) is selected, add black border around entire content. Skip for recording to avoid wireframe ghost.
      if (avatarDecor === "none" && !forceRecordRes) {
        ctx.save();
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 4;
        ctx.setLineDash([]);
        ctx.strokeRect(0, 0, w, h);
        ctx.restore();
      }

      /** Encoded-frame outline during recording (~3 output px): matches export aspect so Landscape vs Portrait reads clearly. Capture pane chrome stays thick black only for landscape Frame (see column shell). */
      if (forceRecordRes && isRecording) {
        const outlinePx = SHARE_WINDOW_BORDER_OUT_PX;
        ctx.save();
        ctx.strokeStyle = "#000000";
        ctx.lineJoin = "miter";
        ctx.setLineDash([]);
        ctx.lineWidth = outlinePx;
        ctx.strokeRect(outlinePx / 2, outlinePx / 2, w - outlinePx, h - outlinePx);
        ctx.restore();
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
      pipEffectBackend,
      activeScreenStream,
      cameraStream,
      recordOutputDimensions,
      recordResolution,
      recordOutputShape,
      letterboxBackground,
      letterboxCustomImage,
      letterboxMode,
      isRecording,
      fullPageWhiteboard,
      previewLayoutMode,
      detachedHelpersEnabled,
      pipPos,
      fullPagePipPos,
      avatarSizeDisplay,
      avatarWidthDisplay,
      avatarHeightDisplay,
      whiteboardPanelWidth,
      shareWindowFillPercent,
      sharePortraitWindowPanNorm,
      whiteboardRecordSurfacePanNorm,
      omitPipFromRecording,
    ]
  );

  const drawCompositeRef = useRef(drawComposite);
  drawCompositeRef.current = drawComposite;

  const scheduleShareInteractionDraw = useCallback(() => {
    if (shareInteractionDrawRafRef.current != null) return;
    shareInteractionDrawRafRef.current = requestAnimationFrame(() => {
      shareInteractionDrawRafRef.current = null;
      drawCompositeRef.current?.(false);
    });
  }, []);

  const applyWbMiniPipLiveLayoutDom = useCallback(
    (p: { x: number; y: number }) => {
      const x = Math.max(0, p.x);
      const y = Math.max(0, p.y);
      const aw = avatarWidthDisplay;
      const ah = avatarHeightDisplay;
      const br = PIP_BR_RESIZE_HANDLE_PX;
      let col: DOMRect | null = null;
      const pv = previewRef.current;
      if (pv) {
        const r = pv.getBoundingClientRect();
        if (r.width >= 2 && r.height >= 2) col = r;
      }
      if (!col) {
        const fb = portalRectLiveRef.current ?? portalRect;
        if (fb && fb.width >= 2 && fb.height >= 2) col = fb;
      }
      const hit = wbPreviewPipHitRef.current;
      if (hit) {
        hit.style.left = `${x}px`;
        hit.style.top = `${y}px`;
      }
      const brHit = wbPreviewPipBrHitRef.current;
      if (brHit) {
        brHit.style.left = `${x + aw - br}px`;
        brHit.style.top = `${y + ah - br}px`;
      }
      const portal = pipRef.current;
      if (portal && fullPageWhiteboard && !activeScreenStream && col) {
        portal.style.left = `${col.left + x}px`;
        portal.style.top = `${col.top + y}px`;
      }
    },
    [
      activeScreenStream,
      avatarHeightDisplay,
      avatarWidthDisplay,
      fullPageWhiteboard,
      portalRect,
    ]
  );

  const clearWbMiniPipLiveLayoutDom = useCallback(() => {
    wbPreviewPipHitRef.current?.style.removeProperty("left");
    wbPreviewPipHitRef.current?.style.removeProperty("top");
    wbPreviewPipBrHitRef.current?.style.removeProperty("left");
    wbPreviewPipBrHitRef.current?.style.removeProperty("top");
    pipRef.current?.style.removeProperty("left");
    pipRef.current?.style.removeProperty("top");
  }, []);

  const onWbMiniPipLive = useCallback(
    (p: { x: number; y: number }) => {
      const liveMap = wbPipMapDimsFromPreviewEl(previewRef.current);
      const mapW = Math.max(1, Math.round(liveMap?.pipMapW ?? wbRecordMinimapPipMap.pipMapW));
      const mapH = Math.max(1, Math.round(liveMap?.pipMapH ?? wbRecordMinimapPipMap.pipMapH));
      const safe = {
        x: Math.max(
          0,
          Math.min(
            Math.max(0, mapW - avatarWidthDisplay),
            Number.isFinite(p.x) ? Math.round(p.x) : 0
          )
        ),
        y: Math.max(
          0,
          Math.min(
            Math.max(0, mapH - avatarHeightDisplay),
            Number.isFinite(p.y) ? Math.round(p.y) : 0
          )
        ),
      };
      fullPagePipPosRef.current = safe;
      applyWbMiniPipLiveLayoutDom(safe);
      if (fullPageWhiteboard && !activeScreenStreamRef.current) {
        pipPortalVisualRef.current?.style.setProperty("visibility", "visible");
      }
      drawCameraOverlayRef.current?.();
      scheduleWbMiniPipLayoutSyncFromRef();
      const wbOnlyLive = fullPageWhiteboard && !activeScreenStreamRef.current;
      if (isRecording && wbOnlyLive) {
        if (wbMiniPipLiveCompositeRafRef.current) cancelAnimationFrame(wbMiniPipLiveCompositeRafRef.current);
        wbMiniPipLiveCompositeRafRef.current = requestAnimationFrame(() => {
          wbMiniPipLiveCompositeRafRef.current = 0;
          drawCameraOverlayRef.current?.();
          drawCompositeRef.current?.(true);
        });
      } else {
        drawCompositeRef.current?.();
      }
    },
    [
      applyWbMiniPipLiveLayoutDom,
      fullPageWhiteboard,
      isRecording,
      scheduleWbMiniPipLayoutSyncFromRef,
      wbRecordMinimapPipMap.pipMapW,
      wbRecordMinimapPipMap.pipMapH,
      avatarWidthDisplay,
      avatarHeightDisplay,
    ]
  );

  const onWbMiniPipMiniDragActive = useCallback((active: boolean) => {
    wbMiniPipDraggingRef.current = active;
    if (active) {
      screenRecPipCompositeStickyRef.current = false;
      scheduleWbMiniPipLayoutSyncFromRef();
    }
    drawCameraOverlayRef.current?.();
    drawCompositeRef.current?.(isRecordingRef.current);
    if (!active && wbMiniPipLiveCompositeRafRef.current) {
      cancelAnimationFrame(wbMiniPipLiveCompositeRafRef.current);
      wbMiniPipLiveCompositeRafRef.current = 0;
    }
    if (!active && wbMiniPipLayoutBumpRafRef.current) {
      cancelAnimationFrame(wbMiniPipLayoutBumpRafRef.current);
      wbMiniPipLayoutBumpRafRef.current = 0;
    }
  }, [scheduleWbMiniPipLayoutSyncFromRef]);

  /** Live pip map for minimap — uses same helper as props / drawComposite (preview element). */
  const getWbMinimapPipMapCssSize = useCallback(() => {
    const d = wbPipMapDimsFromPreviewEl(previewRef.current);
    if (d && d.pipMapW >= 50 && d.pipMapH >= 50) return { w: d.pipMapW, h: d.pipMapH };
    return null;
  }, []);

  const onWbMiniPipCommit = useCallback(
    (p: { x: number; y: number }) => {
      const liveMap = wbPipMapDimsFromPreviewEl(previewRef.current);
      const mapW = Math.max(1, Math.round(liveMap?.pipMapW ?? wbRecordMinimapPipMap.pipMapW));
      const mapH = Math.max(1, Math.round(liveMap?.pipMapH ?? wbRecordMinimapPipMap.pipMapH));
      const safe = {
        x: Math.max(
          0,
          Math.min(
            Math.max(0, mapW - avatarWidthDisplay),
            Number.isFinite(p.x) ? Math.round(p.x) : 0
          )
        ),
        y: Math.max(
          0,
          Math.min(
            Math.max(0, mapH - avatarHeightDisplay),
            Number.isFinite(p.y) ? Math.round(p.y) : 0
          )
        ),
      };
      if (wbMiniPipLiveCompositeRafRef.current) {
        cancelAnimationFrame(wbMiniPipLiveCompositeRafRef.current);
        wbMiniPipLiveCompositeRafRef.current = 0;
      }
      const bumpRafPending = wbMiniPipLayoutBumpRafRef.current;
      if (bumpRafPending) {
        cancelAnimationFrame(bumpRafPending);
        wbMiniPipLayoutBumpRafRef.current = 0;
      }
      fullPagePipPosRef.current = safe;
      /** Strip minimap imperative left/top *before* flushSync — clearing after flushSync was wiping React-applied portal styles → PiP vanished / ghost stroke. */
      clearWbMiniPipLiveLayoutDom();
      if (typeof localStorage !== "undefined" && localStorage.getItem("dreamwork_debug_wb_pip") === "1") {
        const dims = wbPipMapDimsFromPreviewEl(previewRef.current);
        const live = portalRectLiveRef.current;
        console.info("[dreamwork wb-pip] commit", {
          p: safe,
          previewMap: dims,
          portalLive: live
            ? {
                w: Math.round(live.width),
                h: Math.round(live.height),
                left: Math.round(live.left),
                top: Math.round(live.top),
              }
            : null,
        });
      }
      flushSync(() => {
        setFullPagePipPos(safe);
        /** Same frame as state commit — avoid one rAF delay where portal/minimap still read stale props (release flash). */
        setWbMiniPipLayoutTick((n) => (n + 1) & 65535);
      });
      if (fullPageWhiteboard && !activeScreenStreamRef.current) {
        pipPortalVisualRef.current?.style.setProperty("visibility", "visible");
      }
      const pv = previewRef.current;
      if (pv) {
        const br = pv.getBoundingClientRect();
        if (br.width >= 50 && br.height >= 50) {
          contentAreaPrevRectRef.current = { w: br.width, h: br.height };
        }
      }
      screenRecPipCompositeStickyRef.current = false;
      drawCameraOverlayRef.current?.();
      /** Recording bitmap must use overlay branch (decor baked in overlay canvas); naked drawComposite() made wbRecordFromPortalOverlay false → double stroke. */
      drawCompositeRef.current?.(true);
      queueMicrotask(() => {
        drawCompositeRef.current?.(true);
        requestAnimationFrame(() => {
          drawCameraOverlayRef.current?.();
          drawCompositeRef.current?.(true);
        });
      });
    },
    [
      clearWbMiniPipLiveLayoutDom,
      wbRecordMinimapPipMap.pipMapW,
      wbRecordMinimapPipMap.pipMapH,
      avatarWidthDisplay,
      avatarHeightDisplay,
      fullPageWhiteboard,
    ]
  );

  const onWbMiniSharePctLive = useCallback((pct: number) => {
    const v = Math.min(100, Math.max(40, Math.round(pct)));
    wbMiniShareResizeDragActiveRef.current = true;
    shareWindowFillPercentRef.current = v;
    drawCompositeRef.current?.();
  }, []);

  const onWbMiniSharePctCommit = useCallback((pct: number) => {
    const v = Math.min(100, Math.max(40, Math.round(pct)));
    wbMiniShareResizeDragActiveRef.current = false;
    shareWindowFillPercentRef.current = v;
    setShareWindowFillPercent(v);
    drawCompositeRef.current?.();
  }, []);

  const applySharePanOverlayDom = useCallback(
    (layout: { w: number; h: number; dw: number; dh: number; dx: number; dy: number }) => {
      const root = sharePanOverlayRef.current;
      if (!root) return;
      const rr = root.getBoundingClientRect();
      if (rr.width < 2 || rr.height < 2) return;
      const sx = rr.width / Math.max(1, layout.w);
      const sy = rr.height / Math.max(1, layout.h);
      const x = layout.dx * sx;
      const y = layout.dy * sy;
      const w = Math.max(1, layout.dw * sx);
      const h = Math.max(1, layout.dh * sy);
      sharePanOverlayRectRef.current = { x, y, w, h };
    },
    []
  );

  const pickShareResizeCorner = useCallback(
    (localX: number, localY: number): ShareResizeCorner | null => {
      const r = sharePanOverlayRectRef.current;
      if (!r) return null;
      const hit = Math.max(SHARE_OVERLAY_CORNER_RESIZE_PX, SHARE_OVERLAY_CORNER_HANDLE_PX * 1.6);
      const corners: { c: ShareResizeCorner; x: number; y: number }[] = [
        { c: "nw", x: r.x, y: r.y },
        { c: "ne", x: r.x + r.w, y: r.y },
        { c: "sw", x: r.x, y: r.y + r.h },
        { c: "se", x: r.x + r.w, y: r.y + r.h },
      ];
      for (const p of corners) {
        if (Math.abs(localX - p.x) <= hit && Math.abs(localY - p.y) <= hit) return p.c;
      }
      return null;
    },
    []
  );

  const clampSharePanNorm = (t: number) => Math.min(1, Math.max(-1, t));

  const handleSharePortraitPanPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeScreenStreamRef.current) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    {
      const lockRect = e.currentTarget.getBoundingClientRect();
      const lock = {
        w: quantizeCapturePanePx(lockRect.width),
        h: quantizeCapturePanePx(lockRect.height),
      };
      if (lock.w > 0 && lock.h > 0) {
        shareInteractionPaneLockRef.current = lock;
        screenSharePaneStableRef.current = lock;
      }
    }
    if (!sharePanOverlayRectRef.current && sharePanLayoutRef.current) {
      applySharePanOverlayDom(sharePanLayoutRef.current);
    }
    const pan = sharePortraitPanNormRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const corner = pickShareResizeCorner(localX, localY);
    if (corner) {
      shareOverlayResizeDragActiveRef.current = true;
      sharePortraitPanDragRef.current = {
        mode: "resizePct",
        pointerId: e.pointerId,
        corner,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPct: shareWindowFillPercentRef.current,
        lastPct: shareWindowFillPercentRef.current,
      };
    } else {
      sharePortraitPanDragRef.current = {
        mode: "pan",
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startClientW: Math.max(1, rect.width),
        startClientH: Math.max(1, rect.height),
        startNormX: pan.x,
        startNormY: pan.y,
      };
    }
  }, [pickShareResizeCorner, applySharePanOverlayDom]);

  const handleSharePortraitPanPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sharePortraitPanDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.mode === "resizePct") {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      let vector = 0;
      if (drag.corner === "se") vector = (dx + dy) / 2;
      else if (drag.corner === "nw") vector = (-dx - dy) / 2;
      else if (drag.corner === "ne") vector = (-dx + dy) / 2;
      else vector = (dx - dy) / 2; // sw
      const sens = 0.2;
      const next = Math.min(100, Math.max(40, Math.round(drag.startPct + vector * sens)));
      drag.lastPct = next;
      shareWindowFillPercentRef.current = next;
      scheduleShareInteractionDraw();
      return;
    }
    const L = sharePanLayoutRef.current;
    if (!L) return;
    const rw = drag.startClientW;
    const rh = drag.startClientH;
    if (rw < 1 || rh < 1 || L.w < 1 || L.h < 1) return;
    const scaleX = L.w / rw;
    const scaleY = L.h / rh;
    const slackX = L.w - L.dw;
    const slackY = L.h - L.dh;
    const dxClient = e.clientX - drag.startClientX;
    const dyClient = e.clientY - drag.startClientY;
    let nx = drag.startNormX;
    let ny = drag.startNormY;
    if (slackX > 1) {
      nx = clampSharePanNorm(drag.startNormX + (2 * dxClient * scaleX) / slackX);
    }
    if (slackY > 1) {
      ny = clampSharePanNorm(drag.startNormY + (2 * dyClient * scaleY) / slackY);
    }
    sharePortraitPanNormRef.current = { x: nx, y: ny };
    scheduleShareInteractionDraw();
  }, [scheduleShareInteractionDraw]);

  const handleSharePortraitPanPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sharePortraitPanDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.mode === "resizePct") {
      shareOverlayResizeDragActiveRef.current = false;
      const v = Math.min(100, Math.max(40, Math.round(drag.lastPct)));
      shareWindowFillPercentRef.current = v;
      setShareWindowFillPercent(v);
      queueMicrotask(() => scheduleShareInteractionDraw());
    }
    shareInteractionPaneLockRef.current = null;
    sharePortraitPanDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setSharePortraitWindowPanNorm({ ...sharePortraitPanNormRef.current });
  }, []);

  const handleSharePortraitPanDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeScreenStreamRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    sharePortraitPanNormRef.current = { x: 0, y: 0 };
    setSharePortraitWindowPanNorm({ x: 0, y: 0 });
    queueMicrotask(() => drawCompositeRef.current?.(false));
  }, []);

  useEffect(() => {
    if (activeScreenStream) return;
    shareOverlayResizeDragActiveRef.current = false;
    shareInteractionPaneLockRef.current = null;
    sharePortraitPanDragRef.current = null;
    sharePanOverlayRectRef.current = null;
  }, [activeScreenStream]);

  useEffect(() => {
    return () => {
      if (shareInteractionDrawRafRef.current != null) {
        cancelAnimationFrame(shareInteractionDrawRafRef.current);
        shareInteractionDrawRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!letterboxCustomImage) {
      letterboxCustomImgRef.current = null;
      queueMicrotask(() => drawCompositeRef.current?.());
      return;
    }
    const img = new Image();
    const url = letterboxCustomImage;
    if (url.startsWith("http:") || url.startsWith("https:") || url.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      letterboxCustomImgRef.current = img;
      queueMicrotask(() => drawCompositeRef.current?.());
    };
    img.onerror = () => {
      letterboxCustomImgRef.current = null;
      queueMicrotask(() => drawCompositeRef.current?.());
    };
    img.src = url;
    if (img.complete && img.naturalWidth > 0) {
      letterboxCustomImgRef.current = img;
      queueMicrotask(() => drawCompositeRef.current?.());
    }
    return () => {
      letterboxCustomImgRef.current = null;
    };
  }, [letterboxCustomImage]);

  useEffect(() => {
    drawCompositeRef.current?.();
  }, [shareWindowFillPercent]);

  useEffect(() => {
    drawCompositeRef.current?.();
  }, [sharePortraitWindowPanNorm]);

  /** Live Capture Screen: Frame/Res affect share layout math; refresh without waiting for next video frame so Share% + orientation feel instant. */
  useEffect(() => {
    if (!activeScreenStream || isRecording) return;
    queueMicrotask(() => drawCompositeRef.current?.(false));
  }, [recordOutputShape, recordResolution, activeScreenStream, isRecording]);

  useEffect(() => {
    if (!isRecording) {
      screenRecPipCompositeStickyRef.current = false;
      screenRecCamCacheTickRef.current = 0;
      pipRef.current?.style.removeProperty("opacity");
      pipRef.current?.style.removeProperty("background-color");
      pipPortalVisualRef.current?.style.removeProperty("visibility");
    }
  }, [isRecording]);

  /** WB-only PiP anchor: **previewRef** sync rect first (same as composite + minimap `pipMap`) — stale RO snapshot vs live getBoundingClientRect caused off-screen portal. */
  const wbPipPortalColumnRect = (() => {
    if (!fullPageWhiteboard || activeScreenStream) return null;
    const elPv = previewRef.current;
    if (elPv) {
      const r = elPv.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) {
        wbPipPortalLastRectRef.current = r;
        return r;
      }
    }
    const live = portalRectLiveRef.current;
    if (live && live.width >= 2 && live.height >= 2) {
      wbPipPortalLastRectRef.current = live;
      return live;
    }
    const st = portalRect;
    if (st && st.width >= 2 && st.height >= 2) {
      wbPipPortalLastRectRef.current = st;
      return st;
    }
    /** Without this, `fixed` portal used preview-relative x,y as viewport px — (0,0) rel → true top-left of the screen. */
    const el = previewRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) {
        wbPipPortalLastRectRef.current = r;
        return r;
      }
    }
    return wbPipPortalLastRectRef.current;
  })();

  const activePipPos = fullPageWhiteboard ? fullPagePipForRender : pipPos;
  const cameraViewportPos =
    fullPageWhiteboard
      ? activeScreenStream
        ? fullPagePipForRender
        : wbPipPortalColumnRect
          ? {
              x: wbPipPortalColumnRect.left + fullPagePipForRender.x,
              y: wbPipPortalColumnRect.top + fullPagePipForRender.y,
            }
          : (() => {
              const el = previewRef.current;
              if (!el) return fullPagePipForRender;
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) return fullPagePipForRender;
              return {
                x: r.left + fullPagePipForRender.x,
                y: r.top + fullPagePipForRender.y,
              };
            })()
      : mainLayoutPortalRect
        ? { x: mainLayoutPortalRect.left + pipPos.x, y: mainLayoutPortalRect.top + pipPos.y }
        : pipPos;
  const pipViewportLeft =
    fullPageWhiteboard && activeScreenStream ? fullPagePipForRender.x + CAMERA_OFFSET : activePipPos.x;
  const pipViewportTop =
    fullPageWhiteboard && activeScreenStream ? fullPagePipForRender.y + CAMERA_OFFSET : activePipPos.y;
  const overlapBufPip =
    OVERLAP_BUFFER + (pipDragging ? OVERLAP_BUFFER_PIP_DRAG_EXTRA : 0);
  const previewColumnRectForPip =
    fullPageWhiteboard && activeScreenStream ? portalRectLiveRef.current ?? portalRect : portalRect;
  const cameraOutsidePreviewRaw =
    fullPageWhiteboard &&
    activeScreenStream &&
    previewColumnRectForPip &&
    (pipViewportLeft + avatarWidthDisplay <= previewColumnRectForPip.left + overlapBufPip ||
      pipViewportLeft >= previewColumnRectForPip.right - overlapBufPip ||
      pipViewportTop + avatarHeightDisplay <= previewColumnRectForPip.top + overlapBufPip ||
      pipViewportTop >= previewColumnRectForPip.bottom - overlapBufPip);
  if (fullPageWhiteboard && activeScreenStream && previewColumnRectForPip) {
    capturePipInColumnRef.current = !cameraOutsidePreviewRaw;
  } else {
    capturePipInColumnRef.current = false;
  }
  // During live window resize, this boundary can flap frame-to-frame and cause PiP overlay flicker.
  const cameraOutsidePreviewStableRef = useRef(Boolean(cameraOutsidePreviewRaw));
  if (!windowLiveResize) {
    cameraOutsidePreviewStableRef.current = Boolean(cameraOutsidePreviewRaw);
  }
  const cameraOutsidePreview = windowLiveResize
    ? cameraOutsidePreviewStableRef.current
    : Boolean(cameraOutsidePreviewRaw);

  useLayoutEffect(() => {
    const col = portalRectLiveRef.current ?? portalRect;
    if (!fullPageWhiteboard || !activeScreenStream || !col || !showPip) {
      setPipPortalOverlayOutsideUi(false);
      return;
    }
    const H = 32;
    const pl = pipViewportLeft;
    const pr = pl + avatarWidthDisplay;
    const pt = pipViewportTop;
    const pb = pt + avatarHeightDisplay;
    const deepInside =
      pl >= col.left + H &&
      pr <= col.right - H &&
      pt >= col.top + H &&
      pb <= col.bottom - H;
    const fullyOutside =
      pr <= col.left - H ||
      pl >= col.right + H ||
      pb <= col.top - H ||
      pt >= col.bottom + H;
    setPipPortalOverlayOutsideUi((prev) => {
      if (deepInside) return false;
      if (fullyOutside) return true;
      return prev;
    });
  }, [
    fullPageWhiteboard,
    activeScreenStream,
    portalRect,
    showPip,
    pipViewportLeft,
    pipViewportTop,
    avatarWidthDisplay,
    avatarHeightDisplay,
  ]);

  const outsideForPipOverlay =
    fullPageWhiteboard && activeScreenStream ? pipPortalOverlayOutsideUi : cameraOutsidePreview;

  const portalCameraEdgeOnOverlay = useMemo(() => {
    return (
      (!(fullPageWhiteboard && activeScreenStream) && outsideForPipOverlay) ||
      (!activeScreenStream && !avatarImageSrc) ||
      ((!avatarImageSrc && faceFilter !== "none") ||
        (!avatarImageSrc && pipEffectBackend === "snap"))
    );
  }, [
    fullPageWhiteboard,
    activeScreenStream,
    outsideForPipOverlay,
    avatarImageSrc,
    faceFilter,
    pipEffectBackend,
  ]);

  // Keep camera source video mounted whenever we have camera - so it decodes ahead of recording
  const showCameraSourceVideo = showPip && (!fullPageWhiteboard || isRecording || !!cameraStream);
  const drawCameraOverlay = useCallback(() => {
    const canvas = cameraOverlayRef.current;
    const video = pickDecodedCameraVideo(cameraVideoRef.current, cameraSourceVideoRef.current);
    const img = avatarImgRef.current;
    const snapCanvas =
      pipEffectBackend === "snap" ? snapLiveCanvasRef.current : null;
    const useAvatarImage = showPip && !!avatarImageSrc && img?.complete;
    const useSnapCanvas =
      showPip &&
      pipEffectBackend === "snap" &&
      !useAvatarImage &&
      !!snapCanvas &&
      snapCanvas.width > 0 &&
      snapCanvas.height > 0;
    const videoReadyForOverlay = cameraVideoReadableForPipEffects(video);
    const useCamera =
      showPip && !useAvatarImage && pipEffectBackend !== "snap" && videoReadyForOverlay;
    if (!canvas) return;
    if (!useAvatarImage && !useCamera && !useSnapCanvas) return;
    // PiP overlay is small — cap DPR so decode+draw+filters cost less during drag / whiteboard pan.
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
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
      roundRectPath(ctx, 0, 0, pw, ph, Math.min(AVATAR_RECT_RADIUS * dpr, Math.min(pw, ph) / 2));
    }
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, pw, ph);
    if (beautyMode && !useSnapCanvas) ctx.filter = beautySettingsToFilter(beautySettings);
    if (useAvatarImage && img?.naturalWidth) {
      const s = Math.max(pw / img.naturalWidth, ph / img.naturalHeight);
      const sw = img.naturalWidth * s;
      const sh = img.naturalHeight * s;
      ctx.drawImage(img, (pw - sw) / 2, (ph - sh) / 2, sw, sh);
    } else if (useSnapCanvas && snapCanvas) {
      const cw = snapCanvas.width;
      const ch = snapCanvas.height;
      const { drawW, drawH, dx, dy } = pipScaleForVideo(pw, ph, cw, ch);
      ctx.save();
      ctx.translate(dx + drawW, dy);
      ctx.scale(-1, 1);
      ctx.translate(-dx, -dy);
      ctx.drawImage(snapCanvas, 0, 0, cw, ch, dx, dy, drawW, drawH);
      ctx.restore();
    } else if (useCamera && video) {
      const vw = video.videoWidth || pw;
      const vh = video.videoHeight || ph;
      const { drawW, drawH, dx, dy } = pipScaleForVideo(pw, ph, vw, vh);
      ctx.save();
      ctx.translate(dx + drawW, dy);
      ctx.scale(-1, 1);
      ctx.translate(-dx, -dy);
      ctx.drawImage(video, 0, 0, vw, vh, dx, dy, drawW, drawH);
      ctx.restore();
      if (pipEffectBackend === "mediapipe" && faceFilter !== "none") {
        try {
          const lm =
            faceLandmarksRef.current ??
            (performance.now() - lastValidLandmarksAtRef.current < LANDMARK_PERSIST_MS
              ? lastValidLandmarksRef.current
              : null);
          const nowMs = performance.now();
          ctx.filter = "none";
          drawFaceFilter(ctx, lm, faceFilter, dx, dy, drawW, drawH, true, nowMs);
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
      roundRectPath(ctx, 0, 0, pw, ph, Math.min(AVATAR_RECT_RADIUS * dpr, Math.min(pw, ph) / 2));
    }
    if (avatarDecor !== "none" && avatarDecor !== "dashed") {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5;
      ctx.setLineDash([]);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.stroke();
    }
    ctx.strokeStyle = avatarDecor === "none" ? "#000" : "rgba(255,255,255,0.95)";
    const strokePx = avatarDecor === "dashed" ? 2 : avatarDecor === "simple" ? 2 : avatarDecor === "none" ? 2 : 3;
    ctx.lineWidth = strokePx * dpr;
    if (avatarDecor === "dashed") ctx.setLineDash([8 * dpr, 4 * dpr]);
    else ctx.setLineDash([]);
    if (
      avatarDecor === "glow" &&
      !(isRecording && (pipDraggingRef.current || wbMiniPipDraggingRef.current))
    ) {
      ctx.shadowColor = hexToRgba(glowColor, 0.85);
      ctx.shadowBlur = 48;
    } else {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }
    ctx.stroke();
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
    pipEffectBackend,
    avatarWidthDisplay,
    avatarHeightDisplay,
    fullPageWhiteboard,
    isRecording,
  ]);

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
    if (
      faceFilter === "none" ||
      !showPip ||
      avatarImageSrc ||
      pipEffectBackend !== "mediapipe"
    ) {
      faceLandmarksRef.current = null;
      lastValidLandmarksRef.current = null;
    }
  }, [faceFilter, showPip, avatarImageSrc, pipEffectBackend]);

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
    if (windowLiveResize) return;
    /** While recording, minimap / main PiP drag + `portalRect` ResizeObserver own position; this idle clamp used `contentArea` width that can be 0 or < avatar briefly → forced (0,0) and killed the portal + minimap orange box. */
    if (isRecording) return;
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
    // Use content area (whiteboard + right panel) so camera can be dragged to Capture screen
    const container = contentAreaRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setFullPagePipPos((prev) => {
      const next = {
        x: Math.max(0, Math.min(rect.width - avatarWidthDisplay, prev.x)),
        y: Math.max(0, Math.min(rect.height - avatarHeightDisplay, prev.y)),
      };
      return next.x === prev.x && next.y === prev.y ? prev : next;
    });
  }, [
    showPip,
    pipDragging,
    fullPageWhiteboard,
    activeScreenStream,
    avatarWidthDisplay,
    avatarHeightDisplay,
    fullPagePreviewPos,
    whiteboardPanelWidth,
    windowLiveResize,
    isRecording,
  ]);

  const handleSplitResizeSessionStart = useCallback(() => {
    splitClientXDragRef.current = null;
    contentAreaRef.current?.setAttribute("data-dw-split-dragging", "");
  }, []);

  const handleSplitResizePointerDone = useCallback(() => {
    contentAreaRef.current?.removeAttribute("data-dw-split-dragging");
  }, []);

  const scheduleSplitAffordanceLive = useCallback((strip: number, content: number) => {
    splitAffordancePendingRef.current = {
      strip: Math.max(SPLIT_STRIP_MIN_PX, Math.round(strip)),
      content: Math.max(0, Math.round(content)),
    };
    if (splitAffordanceLiveRafRef.current == null) {
      splitAffordanceLiveRafRef.current = requestAnimationFrame(() => {
        splitAffordanceLiveRafRef.current = null;
        const p = splitAffordancePendingRef.current;
        if (p) setSplitAffordanceLive(p);
      });
    }
  }, []);

  useEffect(() => {
    return () => {
      if (splitAffordanceLiveRafRef.current != null) {
        cancelAnimationFrame(splitAffordanceLiveRafRef.current);
        splitAffordanceLiveRafRef.current = null;
      }
    };
  }, []);

  /** Drag changes narrow strip width only; which side is main (1fr) follows `splitMainIsCapture`, not drag. */
  const handleMainPanelResizeFromClientX = useCallback((clientX: number) => {
    splitPanelDragActiveRef.current = true;
    if (!splitDragSessionRef.current) {
      splitDragSessionRef.current = true;
    }
    if (!splitClientXDragRef.current) {
      splitClientXDragRef.current = {
        startX: clientX,
        startW: whiteboardPanelWidthRef.current,
      };
    }
    const { startX, startW } = splitClientXDragRef.current;
    const captureMain = splitMainIsCaptureRef.current;
    const contentW = contentAreaRef.current?.offsetWidth ?? 0;
    const maxW = contentW > 0 ? contentW - 54 : Math.max(600, window.innerWidth - 480);
    const dx = clientX - startX;
    const d = captureMain ? dx : -dx;
    const raw = Math.round(startW + d);
    const next = Math.max(
      SPLIT_STRIP_MIN_PX,
      Math.min(maxW, Number.isFinite(raw) ? raw : SPLIT_STRIP_MIN_PX)
    );
    if (next === whiteboardPanelWidthRef.current) return;
    whiteboardPanelWidthRef.current = next;
    const tri = splitTriPaneRef.current;
    const wb = fullPageContentRef.current;
    tri?.style.setProperty("--dreamwork-strip-px", `${next}px`);
    if (captureMain) {
      tri?.style.setProperty("grid-template-columns", splitGridTemplate(next, true));
      if (wb) {
        wb.style.setProperty("width", `${next}px`);
        wb.style.setProperty("min-width", `${SPLIT_STRIP_MIN_PX}px`);
        wb.style.setProperty("max-width", `${next}px`);
        wb.style.setProperty("box-sizing", "border-box");
      }
    } else {
      tri?.style.setProperty("grid-template-columns", splitGridTemplate(next, false));
    }
    const cw = contentAreaRef.current?.offsetWidth ?? 0;
    scheduleSplitAffordanceLive(next, cw);
  }, [scheduleSplitAffordanceLive]);

  const handleMainPanelResizeEnd = useCallback(() => {
    if (splitAffordanceLiveRafRef.current != null) {
      cancelAnimationFrame(splitAffordanceLiveRafRef.current);
      splitAffordanceLiveRafRef.current = null;
    }
    splitAffordancePendingRef.current = null;
    setSplitAffordanceLive(null);
    splitClientXDragRef.current = null;
    let w = Math.max(SPLIT_STRIP_MIN_PX, Math.round(whiteboardPanelWidthRef.current));
    const exitSqueeze =
      captureMainNoStreamRef.current &&
      !activeScreenStreamRef.current &&
      w > SPLIT_STRIP_MIN_PX + 24;
    if (exitSqueeze) {
      setCaptureMainNoStream(false);
      w = SPLIT_STRIP_MIN_PX;
    }
    whiteboardPanelWidthRef.current = w;
    splitPanelDragActiveRef.current = false;
    splitDragSessionRef.current = false;
    setWhiteboardPanelWidth(w);
    const stream = !!activeScreenStreamRef.current;
    const captureMainLayout =
      (stream || (captureMainNoStreamRef.current && !exitSqueeze)) &&
      !(stream && preferWhiteboardMainRef.current);
    const tri = splitTriPaneRef.current;
    const wb = fullPageContentRef.current;
    if (tri) {
      tri.style.setProperty("--dreamwork-strip-px", `${w}px`);
      if (captureMainLayout) {
        tri.style.setProperty("grid-template-columns", splitGridTemplate(w, true));
        if (wb) {
          wb.style.setProperty("width", `${w}px`);
          wb.style.setProperty("min-width", `${SPLIT_STRIP_MIN_PX}px`);
          wb.style.setProperty("max-width", `${w}px`);
          wb.style.setProperty("box-sizing", "border-box");
        }
      } else {
        tri.style.setProperty("grid-template-columns", splitGridTemplate(w, false));
        if (wb) {
          wb.style.removeProperty("width");
          wb.style.removeProperty("min-width");
          wb.style.removeProperty("max-width");
        }
      }
    }
    requestAnimationFrame(() => {
      splitTriPaneRef.current?.style.setProperty("--dreamwork-strip-px", `${w}px`);
    });
  }, []);

  /** Window/content resize: measured width for affordances only. Strip width stays on ref + React — never re-clamp from window here. */
  useLayoutEffect(() => {
    const root = contentAreaRef.current;
    if (!root) return;
    let raf = 0;
    const onContentSizeChange = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (splitPanelDragActiveRef.current) return;
        const cw = root.offsetWidth;
        if (cw <= 0) return;
        if (cw === contentAreaWidthRoRef.current) return;
        contentAreaWidthRoRef.current = cw;
        setContentAreaSplitWidth(cw);
      });
    };
    const ro = new ResizeObserver(onContentSizeChange);
    ro.observe(root);
    window.addEventListener("resize", onContentSizeChange);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", onContentSizeChange);
    };
  }, []);

  /** Re-apply split layout after paint. `captureMainNoStream`: wb-main column squeezed → right column 1fr. */
  useLayoutEffect(() => {
    if (splitPanelDragActiveRef.current) return;
    const tri = splitTriPaneRef.current;
    const wb = fullPageContentRef.current;
    if (!tri) return;
    let spx = Math.max(SPLIT_STRIP_MIN_PX, Math.round(whiteboardPanelWidthRef.current));
    const hasStream = !!activeScreenStream;
    const splitMain =
      (hasStream || captureMainNoStream) && !(hasStream && preferWhiteboardMain);
    const cw = contentAreaRef.current?.offsetWidth ?? 0;
    if (cw > 0) {
      const maxStrip = Math.max(SPLIT_STRIP_MIN_PX, cw - 14 - SPLIT_STRIP_MIN_PX);
      if (spx > maxStrip) {
        spx = maxStrip;
        whiteboardPanelWidthRef.current = spx;
        setWhiteboardPanelWidth(spx);
      }
    }
    const stripForTpl =
      splitMain && hasStream ? spx : splitMain && !hasStream ? SPLIT_STRIP_MIN_PX : spx;
    tri.style.setProperty("--dreamwork-strip-px", `${stripForTpl}px`);
    if (splitMain) {
      tri.style.setProperty("grid-template-columns", splitGridTemplate(stripForTpl, true));
      if (wb) {
        wb.style.setProperty("box-sizing", "border-box");
        wb.style.setProperty("width", `${stripForTpl}px`);
        wb.style.setProperty("min-width", `${SPLIT_STRIP_MIN_PX}px`);
        wb.style.setProperty("max-width", `${stripForTpl}px`);
      }
    } else {
      tri.style.setProperty("grid-template-columns", splitGridTemplate(spx, false));
      if (wb) {
        wb.style.removeProperty("width");
        wb.style.removeProperty("min-width");
        wb.style.removeProperty("max-width");
      }
    }
  }, [
    whiteboardPanelWidth,
    activeScreenStream,
    hasScreen,
    contentAreaSplitWidth,
    width,
    captureMainNoStream,
    preferWhiteboardMain,
  ]);

  /** After share on/off, content width may be unchanged but the measured strip ref switches — allow the next resize pass to re-clamp. */
  useLayoutEffect(() => {
    contentAreaWidthRoRef.current = 0;
  }, [activeScreenStream]);

  /** Hard floor: persisted or any bug must not leave strip width below minimum. */
  useEffect(() => {
    if (whiteboardPanelWidth < SPLIT_STRIP_MIN_PX) {
      whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
      setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX);
    }
  }, [whiteboardPanelWidth]);

  const handleOutputResize = useCallback((delta: number) => {
    setOutputHeight((h) =>
      Math.max(120, Math.min(Math.round(window.innerHeight * 0.7), Math.round(h - delta)))
    );
  }, []);

  function clearRecordingAudioGraphRefs() {
    recordingScreenAudioSourceRef.current?.disconnect();
    recordingScreenAudioSourceRef.current = null;
    recordingSysGainRef.current?.disconnect();
    recordingSysGainRef.current = null;
    recordingAudioDestRef.current = null;
  }

  const applyScreenCaptureStream = useCallback((stream: MediaStream) => {
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        setPreviewScreenStream((s) => (s === stream ? null : s));
        setWhiteboardScreenStream((w) => (w === stream ? null : w));
        if (isElectron && !isRecordingRef.current) void setNormalMode().catch(() => undefined);
      };
    }
    setWhiteboardScreenStream(stream);
    setPreviewScreenStream(stream);
    setPreferWhiteboardMain(false);
    whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
    setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX); // Capture = main; left strip pinned to min immediately (ref + state)
    setShowTeleprompter(false);
    setTeleprompterPlaying(false);
    setShowPip(true);
    if (!cameraStream && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: true }).then((camStream) => {
        setCameraStream(camStream);
        setCaptureError(null);
      }).catch(() => {});
    }
  }, [isElectron, cameraStream]);

  const reconnectRecordingScreenAudio = useCallback((newStream: MediaStream) => {
    const ctx = audioCtxRef.current;
    const dest = recordingAudioDestRef.current;
    if (!ctx || !dest) return;

    recordingScreenAudioSourceRef.current?.disconnect();
    recordingScreenAudioSourceRef.current = null;

    const audioTrack = newStream.getAudioTracks()[0];
    if (!audioTrack) {
      recordingSysGainRef.current?.disconnect();
      recordingSysGainRef.current = null;
      return;
    }

    let gain = recordingSysGainRef.current;
    if (!gain) {
      gain = ctx.createGain();
      recordingSysGainRef.current = gain;
      gain.connect(dest);
    }
    gain.gain.value = systemVolume / 100;
    const src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    src.connect(gain);
    recordingScreenAudioSourceRef.current = src;
  }, [systemVolume]);

  const switchSharedCapture = useCallback(async () => {
    if (captureScreenInFlightRef.current) return;
    const prevStream = whiteboardScreenStreamRef.current ?? previewScreenStreamRef.current;
    if (!prevStream) return;
    captureScreenInFlightRef.current = true;
    setCaptureError(null);
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setCaptureError("Screen capture is not available. Use HTTPS or localhost.");
        return;
      }
      const stream = await getDisplayMediaForScreenCapture(true);
      applyScreenCaptureStream(stream);
      if (prevStream !== stream) {
        prevStream.getTracks().forEach((t) => t.stop());
      }
      const mr = mediaRecorderRef.current;
      if (mr && (mr.state === "recording" || mr.state === "paused")) {
        reconnectRecordingScreenAudio(stream);
      }
    } catch (e) {
      if (isDisplayMediaUserCancellation(e)) {
        setCaptureError(null);
        return;
      }
      const msg = e instanceof Error ? e.message : "Permission denied";
      setCaptureError(
        msg.includes("denied") || msg.includes("NotAllowed")
          ? "Screen capture denied. On macOS, enable Screen Recording for this app in System Settings → Privacy & Security."
          : msg
      );
    } finally {
      captureScreenInFlightRef.current = false;
    }
  }, [applyScreenCaptureStream, reconnectRecordingScreenAudio]);

  const captureScreen = async () => {
    if (captureScreenInFlightRef.current) return;
    captureScreenInFlightRef.current = true;
    setCaptureError(null);
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setCaptureError("Screen capture is not available. Use HTTPS or localhost.");
        return;
      }
      try {
        const stream = await getDisplayMediaForScreenCapture(true);
        applyScreenCaptureStream(stream);
      } catch (e) {
        if (isDisplayMediaUserCancellation(e)) {
          setCaptureError(null);
          return;
        }
        const msg = e instanceof Error ? e.message : "Permission denied";
        setCaptureError(
          msg.includes("denied") || msg.includes("NotAllowed")
            ? "Screen capture denied. On macOS, enable Screen Recording for this app in System Settings → Privacy & Security."
            : msg
        );
      }
    } finally {
      captureScreenInFlightRef.current = false;
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
      // On macOS Electron: request system camera access so Control Center shows camera settings
      const electronAPI = (window as unknown as { electronAPI?: { requestCameraAccess?: () => Promise<boolean> } }).electronAPI;
      if (electronAPI?.requestCameraAccess) {
        const granted = await electronAPI.requestCameraAccess();
        if (!granted) {
          setCaptureError("Camera permission denied.");
          return;
        }
      }
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

  /** Move PiP to bottom-left of the whiteboard column (viewport coords when sharing; portal-relative when wb-only). */
  const computeParkedFullPagePipPos = (): { x: number; y: number } | null => {
    if (!fullPageWhiteboard) return null;
    const wb = fullPageContentRef.current;
    const content = contentAreaRef.current;
    if (!wb || !content) return null;
    const aw = avatarWidthDisplay;
    const ah = avatarHeightDisplay;
    const m = 8;
    const wbR = wb.getBoundingClientRect();
    if (wbR.width < 48 || wbR.height < 48) return null;
    if (activeScreenStream) {
      const visualLeft = wbR.left + m;
      const visualTop = wbR.bottom - ah - m;
      return { x: visualLeft - CAMERA_OFFSET, y: visualTop - CAMERA_OFFSET };
    }
    const portalR = content.getBoundingClientRect();
    const relX = Math.round(wbR.right - portalR.left - aw - m);
    const relY = Math.round(wbR.bottom - portalR.top - ah - m);
    const clampedX = Math.max(
      Math.round(wbR.left - portalR.left + m),
      Math.min(relX, Math.round(wbR.right - portalR.left - aw - m))
    );
    const clampedY = Math.max(
      Math.round(wbR.top - portalR.top + m),
      Math.min(relY, Math.round(wbR.bottom - portalR.top - ah - m))
    );
    return { x: clampedX, y: clampedY };
  };

  const parkPipOnWhiteboard = () => {
    if (!fullPageWhiteboard || !showPip) return;
    const next = computeParkedFullPagePipPos();
    if (!next) return;
    fullPagePipPosRef.current = next;
    setFullPagePipPos(next);
    if (isRecordingRef.current && recordingDrawAndDisplayRef.current) {
      queueMicrotask(() => {
        drawCameraOverlayRef.current?.();
        recordingDrawAndDisplayRef.current?.();
      });
    }
  };

  const startRecording = async () => {
    let fpSnap = fullPagePipPos;
    if (showPip && fullPageWhiteboard && autoParkPipOnRecordStart) {
      const parked = computeParkedFullPagePipPos();
      if (parked) fpSnap = parked;
    }
    pipPosRef.current = pipPos;
    fullPagePipPosRef.current = fpSnap;
    if (fpSnap.x !== fullPagePipPos.x || fpSnap.y !== fullPagePipPos.y) {
      setFullPagePipPos(fpSnap);
    }
    const hasContent = activeScreenStream || showPip;
    if (!hasContent) {
      return;
    }

    await new Promise((r) => requestAnimationFrame(r));
    if (fullPageWhiteboard && !activeScreenStream) {
      await new Promise((r) => requestAnimationFrame(r));
    }

    let composite = compositeRef.current;
    let preview = previewRef.current ?? (fullPageWhiteboard && !activeScreenStream ? contentAreaRef.current : null);
    if (!preview || !composite) {
      return;
    }

    recordingSessionIncludePipRef.current = showPip;
    screenRecPipCompositeStickyRef.current = false;
    if (omitPipFromRecording && showPip) {
      setOmitPipFromRecording(false);
      saveSettings({ ...getSettingsMergeBase(), omitPipFromRecording: false });
    }

    setIsRecording(true);
    isRecordingRef.current = true;
    if (isElectron) void setBackgroundThrottling(false);
    if (isDreamworkCaptureDebugEnabled() && activeScreenStream) {
      captureDebugScreenHitRef.current = 0;
      captureDebugScreenMissRef.current = 0;
      captureDebugThrottleAtRef.current = 0;
    }
    await new Promise((r) => requestAnimationFrame(r));

    const res = recordOutputDimensions;
    const whiteboardOnly = fullPageWhiteboard && !activeScreenStream;
    if (whiteboardOnly) {
      recordWhiteboardPreviewSizeRef.current = {
        w: Math.max(1, preview.offsetWidth),
        h: Math.max(1, preview.offsetHeight),
      };
    } else {
      recordWhiteboardPreviewSizeRef.current = null;
    }
    const recCanvas = document.createElement("canvas");
    recCanvas.width = res.w;
    recCanvas.height = res.h;
    recordingCanvasRef.current = recCanvas;
    // Detached canvas: captureStream() often emits blank/stuck frames in Chromium/Electron (PiP missing in export). Always attach off-screen like whiteboard-only.
    recCanvas.style.cssText = `position:fixed;left:-9999px;top:0;width:${res.w}px;height:${res.h}px;opacity:0.01;pointer-events:none;z-index:-1`;
    document.body.appendChild(recCanvas);

    const targetFps = 30;
    const frameMs = 1000 / targetFps;
    const ctxPrime = recCanvas.getContext("2d");
    if (ctxPrime) ctxPrime.getImageData(0, 0, 1, 1);
    const canvasStream = recCanvas.captureStream(0);
    const captureRecordPreviewLayout = ():
      | {
          comp: HTMLCanvasElement;
          rec: HTMLCanvasElement;
          dispW: number;
          dispH: number;
        }
      | null => {
      const rec = recordingCanvasRef.current;
      const comp = compositeRef.current;
      if (
        whiteboardOnly ||
        !fullPageWhiteboard ||
        !rec ||
        !comp ||
        rec.width <= 0 ||
        rec.height <= 0 ||
        !activeScreenStreamRef.current
      ) {
        return null;
      }
      const prevEl = previewRef.current;
      const stPane = screenSharePaneStableRef.current;
      const paneW =
        prevEl && stPane
          ? stPane.w
          : prevEl
            ? quantizeCapturePanePx(prevEl.getBoundingClientRect().width)
            : contentAreaRef.current?.offsetWidth ?? rec.width;
      const paneH =
        prevEl && stPane
          ? stPane.h
          : prevEl
            ? quantizeCapturePanePx(prevEl.getBoundingClientRect().height)
            : contentAreaRef.current?.offsetHeight ?? rec.height;
      const fitted = fitRectWithAspectInside(paneW, paneH, rec.width, rec.height);
      const dispW = Math.max(1, Math.round(fitted.w));
      const dispH = Math.max(1, Math.round(fitted.h));
      return { comp, rec, dispW, dispH };
    };

    const applyCaptureRecordingCompositeCss = (
      layout: NonNullable<ReturnType<typeof captureRecordPreviewLayout>>
    ) => {
      const sw = `${layout.dispW}px`;
      const sh = `${layout.dispH}px`;
      const { comp } = layout;
      if (comp.style.width !== sw) comp.style.width = sw;
      if (comp.style.height !== sh) comp.style.height = sh;
      void comp.offsetHeight;
    };

    canvasCaptureTrackRef.current = canvasStream.getVideoTracks()[0] ?? null;

    /** Match on-screen composite box to fitted preview **before** first drawComposite so PiP scale maps immediately (fixes ~5–10s drag lag). */
    if (composite && fullPageWhiteboard && activeScreenStream && preview) {
      const st0 = screenSharePaneStableRef.current;
      const pww =
        st0?.w ??
        quantizeCapturePanePx(preview.getBoundingClientRect().width);
      const phh =
        st0?.h ??
        quantizeCapturePanePx(preview.getBoundingClientRect().height);
      const f0 = fitRectWithAspectInside(pww, phh, res.w, res.h);
      composite.style.width = `${Math.max(1, Math.round(f0.w))}px`;
      composite.style.height = `${Math.max(1, Math.round(f0.h))}px`;
      void composite.offsetHeight;
    }
    drawCompositeRef.current?.(true);
    requestCanvasCaptureFrame(canvasCaptureTrackRef.current);

    const doDrawAndDisplay = () => {
      const tFrameStart = performance.now();
      recordLoopLastAtRef.current = tFrameStart;
      try {
        const layoutPre = captureRecordPreviewLayout();
        if (layoutPre) applyCaptureRecordingCompositeCss(layoutPre);
        drawCompositeRef.current?.(true);
      } catch {
        /* tainted canvas / draw errors — keep frame loop + requestFrame alive */
      }
      requestCanvasCaptureFrame(canvasCaptureTrackRef.current);
      if (!whiteboardOnly) {
        const layout = captureRecordPreviewLayout();
        if (layout) {
          const { comp, rec, dispW, dispH } = layout;
          const previewDpr = Math.min(2, window.devicePixelRatio || 1);
          const cw = Math.max(1, Math.round(dispW * previewDpr));
          const ch = Math.max(1, Math.round(dispH * previewDpr));
          if (comp.width !== cw || comp.height !== ch) {
            comp.width = cw;
            comp.height = ch;
          }
          const csw = `${dispW}px`;
          const csh = `${dispH}px`;
          if (comp.style.width !== csw) comp.style.width = csw;
          if (comp.style.height !== csh) comp.style.height = csh;
          const ctx = comp.getContext("2d", { alpha: false });
          if (ctx) {
            ctx.drawImage(rec, 0, 0, rec.width, rec.height, 0, 0, cw, ch);
          }
        } else if (fullPageWhiteboard) {
          drawCompositeRef.current?.(false);
        }
      }
      if (
        typeof localStorage !== "undefined" &&
        localStorage.getItem("dreamwork_record_profile") === "1"
      ) {
        const dt = performance.now() - tFrameStart;
        if (dt > 34) {
          console.warn("[DreamWork record] slow frame", Math.round(dt), "ms (composite + preview copy)");
        }
      }
      if (
        isDreamworkCaptureDebugEnabled() &&
        isRecordingRef.current &&
        activeScreenStreamRef.current
      ) {
        const now = performance.now();
        if (now - captureDebugThrottleAtRef.current >= 2500) {
          captureDebugThrottleAtRef.current = now;
          const sv = screenVideoRef.current;
          const tr = activeScreenStreamRef.current?.getVideoTracks?.()[0];
          let trState: string | undefined;
          try {
            trState = tr?.readyState;
          } catch {
            trState = undefined;
          }
          console.info("[DreamWorks capture-debug] sample", {
            ms: Math.round(now),
            visibility: typeof document !== "undefined" ? document.visibilityState : undefined,
            screenVideo: sv
              ? {
                  readyState: sv.readyState,
                  videoWidth: sv.videoWidth,
                  videoHeight: sv.videoHeight,
                  paused: sv.paused,
                  ended: sv.ended,
                }
              : null,
            mediaTrack: tr
              ? { muted: tr.muted, enabled: tr.enabled, readyState: trState }
              : null,
            frames: {
              screenDrawEligible: captureDebugScreenHitRef.current,
              screenDrawSkipped: captureDebugScreenMissRef.current,
            },
          });
        }
      }
    };
    recordingDrawAndDisplayRef.current = doDrawAndDisplay;
    let lastDrawAt = 0;

    const drawTick = () => {
      const now = performance.now();
      const dragging = pipDraggingRef.current || wbMiniPipDraggingRef.current;
      if (dragging || now - lastDrawAt >= frameMs) {
        const elapsed = now - lastDrawAt;
        lastDrawAt = now;
        doDrawAndDisplay();
        if (!dragging && elapsed > frameMs * 1.6) {
          const missed = Math.min(Math.floor(elapsed / frameMs) - 1, 4);
          const track = canvasCaptureTrackRef.current;
          for (let i = 0; i < missed; i++) requestCanvasCaptureFrame(track);
        }
      }
    };

    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (whiteboardOnly && sched?.yield) {
      sched.yield().then(doDrawAndDisplay).catch(doDrawAndDisplay);
    } else {
      doDrawAndDisplay();
    }
    lastDrawAt = performance.now();
    /* Foreground: rAF aligns with display refresh and reduces jank vs MessageChannel while Excalidraw + screen capture load the main thread.
       Background: rAF can drop to ~1fps in Electron — keep MessageChannel there so long recordings stay time-accurate. */
    let mcStop: (() => void) | null = null;
    const startMcLoop = () => {
      recordingUsedRafRef.current = false;
      const ch = new MessageChannel();
      let mcStopped = false;
      ch.port2.onmessage = () => {
        if (mcStopped) return;
        drawTick();
        mcScheduleNext();
      };
      const mcScheduleNext = () => {
        if (mcStopped) return;
        const now = performance.now();
        const wait = Math.max(0, frameMs - (now - lastDrawAt) - 1);
        if (wait < 4) {
          ch.port1.postMessage(null);
        } else {
          setTimeout(() => ch.port1.postMessage(null), wait);
        }
      };
      mcScheduleNext();
      mcStop = () => {
        mcStopped = true;
        ch.port1.close();
        ch.port2.close();
        mcStop = null;
      };
    };
    const startRafLoop = () => {
      recordingUsedRafRef.current = true;
      const rafLoop = () => {
        if (!isRecordingRef.current) return;
        drawTick();
        drawLoopIdRef.current = requestAnimationFrame(rafLoop) as unknown as number;
      };
      drawLoopIdRef.current = requestAnimationFrame(rafLoop) as unknown as number;
    };
    const pickRecordingTicker = () => {
      if (drawLoopIdRef.current != null) {
        cancelAnimationFrame(drawLoopIdRef.current);
        drawLoopIdRef.current = null;
      }
      mcStop?.();
      mcStop = null;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        startMcLoop();
      } else {
        startRafLoop();
      }
    };

    if (isElectron) {
      pickRecordingTicker();
      const onVis = () => {
        if (isRecordingRef.current) pickRecordingTicker();
      };
      document.addEventListener("visibilitychange", onVis);
      stopDrawLoopRef.current = () => {
        document.removeEventListener("visibilitychange", onVis);
        if (drawLoopIdRef.current != null) {
          cancelAnimationFrame(drawLoopIdRef.current);
          drawLoopIdRef.current = null;
        }
        mcStop?.();
        mcStop = null;
        stopDrawLoopRef.current = null;
      };
    } else {
      recordingUsedRafRef.current = true;
      const rafLoop = () => {
        drawTick();
        drawLoopIdRef.current = requestAnimationFrame(rafLoop) as unknown as number;
      };
      drawLoopIdRef.current = requestAnimationFrame(rafLoop) as unknown as number;
      stopDrawLoopRef.current = null;
    }

    const audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    audioCtxRef.current = audioCtx;
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();
    recordingAudioDestRef.current = dest;

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
    recordingScreenAudioSourceRef.current = null;
    recordingSysGainRef.current = null;
    if (screenAudio) {
      const sysSource = audioCtx.createMediaStreamSource(
        new MediaStream([screenAudio])
      );
      const sysGain = audioCtx.createGain();
      sysGain.gain.value = systemVolume / 100;
      sysSource.connect(sysGain);
      sysGain.connect(dest);
      recordingScreenAudioSourceRef.current = sysSource;
      recordingSysGainRef.current = sysGain;
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
      recordWhiteboardPreviewSizeRef.current = null;
      canvasCaptureTrackRef.current = null;
      recordingDrawAndDisplayRef.current = null;
      stopDrawLoopRef.current?.(); stopDrawLoopRef.current = null;
      if (drawLoopIdRef.current != null) {
        if (recordingUsedRafRef.current) {
          cancelAnimationFrame(drawLoopIdRef.current);
        } else {
          clearInterval(drawLoopIdRef.current);
        }
        drawLoopIdRef.current = null;
      }
      const recFail = recordingCanvasRef.current;
      if (recFail?.parentNode) recFail.remove();
      recordingCanvasRef.current = null;
      clearRecordingAudioGraphRefs();
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
      if (isElectron) void setBackgroundThrottling(true);
      recordingSessionIncludePipRef.current = false;
      isRecordingRef.current = false;
      setIsRecording(false);
      setCaptureError(err instanceof Error ? err.message : "Failed to initialize recorder");
      return;
    }
    mediaRecorderRef.current = mediaRecorder;
    recordedChunksRef.current = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) recordedChunksRef.current.push(e.data);
    };
    mediaRecorder.onstop = () => {
      recordingSessionIncludePipRef.current = false;
      recordWhiteboardPreviewSizeRef.current = null;
      canvasCaptureTrackRef.current = null;
      recordingDrawAndDisplayRef.current = null;
      stopDrawLoopRef.current?.(); stopDrawLoopRef.current = null;
      if (drawLoopIdRef.current != null) {
        if (recordingUsedRafRef.current) {
          cancelAnimationFrame(drawLoopIdRef.current);
        } else {
          clearInterval(drawLoopIdRef.current);
        }
        drawLoopIdRef.current = null;
      }
      const rec = recordingCanvasRef.current;
      if (rec?.parentNode) rec.remove();
      recordingCanvasRef.current = null;
      if (timerIdRef.current) clearInterval(timerIdRef.current);
      clearRecordingAudioGraphRefs();
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsRecordingPaused(false);
      if (isElectron) void setBackgroundThrottling(true);
      if (isElectron) void setNormalMode();
      const compPost = compositeRef.current;
      if (compPost) {
        compPost.style.removeProperty("width");
        compPost.style.removeProperty("height");
      }
      const chunks = recordedChunksRef.current;
      const recordedMime = mediaRecorder.mimeType || "video/webm";
      if (isDreamworkCaptureDebugEnabled()) {
        const hit = captureDebugScreenHitRef.current;
        const miss = captureDebugScreenMissRef.current;
        const total = hit + miss;
        const sv = screenVideoRef.current;
        console.info("[DreamWorks capture-debug] session end", {
          screenDrawEligibleFrames: hit,
          screenDrawSkippedFrames: miss,
          eligibleRatio: total > 0 ? Number((hit / total).toFixed(4)) : null,
          lastScreenVideo: sv
            ? {
                readyState: sv.readyState,
                videoWidth: sv.videoWidth,
                videoHeight: sv.videoHeight,
              }
            : null,
        });
      }
      requestAnimationFrame(() => {
        drawCompositeRef.current?.(false);
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
      mediaRecorderRef.current = null;
      recordWhiteboardPreviewSizeRef.current = null;
      canvasCaptureTrackRef.current = null;
      recordingDrawAndDisplayRef.current = null;
      stopDrawLoopRef.current?.(); stopDrawLoopRef.current = null;
      if (drawLoopIdRef.current != null) {
        if (recordingUsedRafRef.current) {
          cancelAnimationFrame(drawLoopIdRef.current);
        } else {
          clearInterval(drawLoopIdRef.current);
        }
        drawLoopIdRef.current = null;
      }
      const recStartFail = recordingCanvasRef.current;
      if (recStartFail?.parentNode) recStartFail.remove();
      recordingCanvasRef.current = null;
      clearRecordingAudioGraphRefs();
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
      if (isElectron) void setBackgroundThrottling(true);
      recordingSessionIncludePipRef.current = false;
      isRecordingRef.current = false;
      setIsRecording(false);
      setCaptureError(err instanceof Error ? err.message : "Failed to start recorder");
      return;
    }
    recordingStartRef.current = Date.now();
    setRecordingTime(0);
    // No resize on start recording — window dimensions stay as-is (see Electron setNormalMode).
    timerIdRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartRef.current) / 1000);
      recordingTimeElapsedRef.current = elapsed;
      setRecordingTime(elapsed);
    }, 1000);
  };

  const stopRecording = () => {
    void (async () => {
      const runWb = wbImmediateExportRef.current;
      if (runWb) {
        try {
          await runWb();
        } catch {
          /* best-effort final whiteboard frame with in-edit text overlay */
        }
      }
      const mr = mediaRecorderRef.current;
      if (mr?.state === "recording" || mr?.state === "paused") {
        mr.requestData();
        mr.stop();
      }
    })();
  };

  const performStopScreenShare = () => {
    if (isRecording) {
      stopRecording();
    }
    const stream = whiteboardScreenStream ?? previewScreenStream;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    setWhiteboardScreenStream(null);
    setPreviewScreenStream(null);
    setPreferWhiteboardMain(false);
    if (screenVideoRef.current?.srcObject) {
      screenVideoRef.current.srcObject = null;
    }
    if (isElectron) {
      setNormalMode().catch(() => undefined);
    }
  };

  const stopScreenShare = () => {
    const stream = whiteboardScreenStream ?? previewScreenStream;
    if (!stream) return;
    if (screenShareStopPhase !== "idle") return;

    const reducedMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      performStopScreenShare();
      return;
    }

    setScreenShareStopPhase("exiting");
    screenShareExitTimerRef.current = window.setTimeout(() => {
      screenShareExitTimerRef.current = null;
      performStopScreenShare();
      setScreenShareStopPhase("restoring");
      screenShareRestoreTimerRef.current = window.setTimeout(() => {
        screenShareRestoreTimerRef.current = null;
        setScreenShareStopPhase("idle");
      }, SCREEN_SHARE_RESTORE_MS);
    }, SCREEN_SHARE_EXIT_MS);
  };

  useEffect(() => {
    return () => {
      if (screenShareExitTimerRef.current) clearTimeout(screenShareExitTimerRef.current);
      if (screenShareRestoreTimerRef.current) clearTimeout(screenShareRestoreTimerRef.current);
    };
  }, []);

  /** Stream ended from OS while exit animation is running — don’t leave phase stuck or let timers fire late. */
  useEffect(() => {
    if (!activeScreenStream && screenShareStopPhase === "exiting") {
      if (screenShareExitTimerRef.current) {
        clearTimeout(screenShareExitTimerRef.current);
        screenShareExitTimerRef.current = null;
      }
      if (screenShareRestoreTimerRef.current) {
        clearTimeout(screenShareRestoreTimerRef.current);
        screenShareRestoreTimerRef.current = null;
      }
      setScreenShareStopPhase("idle");
    }
  }, [activeScreenStream, screenShareStopPhase]);

  const pauseRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr?.state !== "recording") return;
    try {
      mr.pause();
    } catch {
      return;
    }
    // Some MIME/codec paths (e.g. certain MP4 recorders) may leave state as "recording" — do not flip UI to Resume
    // or clear the timer, or Resume becomes a no-op while the clock looks frozen.
    const stateAfterPause = mediaRecorderRef.current?.state;
    if (stateAfterPause !== "paused") return;
    if (timerIdRef.current) {
      clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
    setRecordingTime(recordingTimeElapsedRef.current);
    setIsRecordingPaused(true);
  };

  const resumeRecording = () => {
    if (!isRecordingPaused) return;
    const mr = mediaRecorderRef.current;
    if (!mr || mr.state === "inactive") return;
    if (mr.state === "paused") {
      try {
        mr.resume();
      } catch {
        return;
      }
    }
    // After resume(), or if pause() never took effect but UI showed paused, we only restart the clock when encoding again.
    if (mr.state !== "recording") return;
    const elapsed = recordingTimeElapsedRef.current;
    recordingStartRef.current = Date.now() - elapsed * 1000;
    if (timerIdRef.current) {
      clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
    timerIdRef.current = window.setInterval(() => {
      const e = Math.floor((Date.now() - recordingStartRef.current) / 1000);
      recordingTimeElapsedRef.current = e;
      setRecordingTime(e);
    }, 1000);
    setIsRecordingPaused(false);
  };

  const toggleRecord = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  /** Header “Whiteboard”: when capture is main, one click promotes Excalidraw to 1fr and shrinks capture to the 40px strip (optionally after a short strip shrink animation). */
  const handleHeaderWhiteboardLayout = useCallback(() => {
    if (inLiveMeeting) {
      liveMeetingRef.current?.enterCompactMode();
      return;
    }

    const stream = !!activeScreenStreamRef.current;
    const captureMain =
      (stream || captureMainNoStreamRef.current) && !(stream && preferWhiteboardMainRef.current);

    const applyStripWhileCaptureMain = (w: number) => {
      const next = Math.max(SPLIT_STRIP_MIN_PX, Math.round(w));
      whiteboardPanelWidthRef.current = next;
      const tri = splitTriPaneRef.current;
      const wb = fullPageContentRef.current;
      tri?.style.setProperty("--dreamwork-strip-px", `${next}px`);
      tri?.style.setProperty("grid-template-columns", splitGridTemplate(next, true));
      if (wb) {
        wb.style.setProperty("box-sizing", "border-box");
        wb.style.setProperty("width", `${next}px`);
        wb.style.setProperty("min-width", `${SPLIT_STRIP_MIN_PX}px`);
        wb.style.setProperty("max-width", `${next}px`);
      }
    };

    /** Whiteboard already has `1fr`; narrow column is capture on the right — same ref as drag when !captureMain. */
    const applyStripWhileWhiteboardMain = (w: number) => {
      const next = Math.max(SPLIT_STRIP_MIN_PX, Math.round(w));
      whiteboardPanelWidthRef.current = next;
      const tri = splitTriPaneRef.current;
      const wb = fullPageContentRef.current;
      tri?.style.setProperty("--dreamwork-strip-px", `${next}px`);
      tri?.style.setProperty("grid-template-columns", splitGridTemplate(next, false));
      if (wb) {
        wb.style.removeProperty("width");
        wb.style.removeProperty("min-width");
        wb.style.removeProperty("max-width");
      }
    };

    const reducedMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const runViewTransition = (inner: () => void) => {
      if (reducedMotion) {
        inner();
        return;
      }
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      if (typeof doc.startViewTransition === "function") {
        doc.startViewTransition(inner);
      } else {
        inner();
      }
    };

    /** Promote whiteboard to main column; capture becomes the narrow strip (right when stream exists). */
    const finishPromote = () => {
      runViewTransition(() => {
        flushSync(() => {
          if (captureMainNoStreamRef.current && !stream) {
            const cw = contentAreaRef.current?.offsetWidth ?? 0;
            const maxStrip =
              cw > 0 ? Math.max(SPLIT_STRIP_MIN_PX, cw - 14 - SPLIT_STRIP_MIN_PX) : WB_MAIN_DEFAULT_CAPTURE_STRIP_PX;
            const sp = Math.min(WB_MAIN_DEFAULT_CAPTURE_STRIP_PX, maxStrip);
            setCaptureMainNoStream(false);
            whiteboardPanelWidthRef.current = sp;
            setWhiteboardPanelWidth(sp);
          } else if (stream) {
            setPreferWhiteboardMain(true);
            whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
            setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX);
          }
        });
      });
    };

    if (!captureMain) {
      const stripW = whiteboardPanelWidthRef.current;
      if (stripW > SPLIT_STRIP_MIN_PX + 1) {
        if (reducedMotion) {
          flushSync(() => {
            whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
            setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX);
          });
          applyStripWhileWhiteboardMain(SPLIT_STRIP_MIN_PX);
          return;
        }
        splitPanelDragActiveRef.current = true;
        const durationMs = WB_PROMOTE_STRIP_MS;
        const t0 = performance.now();
        const startW = stripW;
        const easeInOutCubic = (u: number) =>
          u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / durationMs);
          const eased = easeInOutCubic(t);
          const w = startW + (SPLIT_STRIP_MIN_PX - startW) * eased;
          applyStripWhileWhiteboardMain(w);
          scheduleSplitAffordanceLive(w, contentAreaRef.current?.offsetWidth ?? 0);
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            splitPanelDragActiveRef.current = false;
            whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
            setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX);
            if (splitAffordanceLiveRafRef.current != null) {
              cancelAnimationFrame(splitAffordanceLiveRafRef.current);
              splitAffordanceLiveRafRef.current = null;
            }
            splitAffordancePendingRef.current = null;
            setSplitAffordanceLive(null);
          }
        };
        requestAnimationFrame(step);
        return;
      }
      if (stream && preferWhiteboardMainRef.current) {
        runViewTransition(() => {
          flushSync(() => {
            setPreferWhiteboardMain(false);
          });
        });
      }
      return;
    }

    if (!stream && captureMainNoStreamRef.current) {
      finishPromote();
      return;
    }

    if (!stream) return;

    const startW = whiteboardPanelWidthRef.current;
    if (reducedMotion || startW <= SPLIT_STRIP_MIN_PX + 1) {
      finishPromote();
      return;
    }

    splitPanelDragActiveRef.current = true;
    const durationMs = WB_PROMOTE_STRIP_MS;
    const t0 = performance.now();

    const easeInOutCubic = (u: number) =>
      u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;

    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const eased = easeInOutCubic(t);
      const w = startW + (SPLIT_STRIP_MIN_PX - startW) * eased;
      applyStripWhileCaptureMain(w);
      scheduleSplitAffordanceLive(w, contentAreaRef.current?.offsetWidth ?? 0);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        splitPanelDragActiveRef.current = false;
        whiteboardPanelWidthRef.current = SPLIT_STRIP_MIN_PX;
        setWhiteboardPanelWidth(SPLIT_STRIP_MIN_PX);
        if (splitAffordanceLiveRafRef.current != null) {
          cancelAnimationFrame(splitAffordanceLiveRafRef.current);
          splitAffordanceLiveRafRef.current = null;
        }
        splitAffordancePendingRef.current = null;
        setSplitAffordanceLive(null);
        finishPromote();
      }
    };
    requestAnimationFrame(step);
  }, [inLiveMeeting, scheduleSplitAffordanceLive]);

  const downloadRecording = (blob: Blob, ext: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dreamwork-recording.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const captureResolutionOverride = useMemo(
    () => getRecordOutputDimensions("2K", recordOutputShape),
    [recordOutputShape]
  );
  const captureScreenshot = useCallback(
    async (presetId: CapturePresetId | CaptureModeId) => {
      try {
        const composite = compositeRef.current;
        if (!composite) return;
        drawCompositeRef.current?.(true, captureResolutionOverride);
        drawCompositeRef.current?.(true, captureResolutionOverride);
        await new Promise((r) => requestAnimationFrame(r));
        let blob: Blob;
        let downloadName: string;
        if (presetId === "preview") {
          const result = await scaleTo2KAndBlob(composite);
          blob = result.blob;
          downloadName = `dreamwork-preview-${result.w}x${result.h}-${Date.now()}.png`;
        } else {
          blob = await captureFrame(composite, presetId as CapturePresetId);
          downloadName = getCaptureFilename(presetId as CapturePresetId);
        }
        if (isElectron) {
          const api = (
            window as unknown as { electronAPI?: { saveImage?: (b: string, n?: string) => Promise<boolean> } }
          ).electronAPI;
          if (api?.saveImage) {
            const base64 = await new Promise<string>((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve((fr.result as string).split(",")[1] ?? "");
              fr.onerror = () => reject(fr.error ?? new Error("Capture read failed"));
              fr.readAsDataURL(blob);
            });
            await api.saveImage(base64, downloadName);
            return;
          }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadName;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        if (err instanceof Error && err.name === "NotAllowedError") return;
        console.error("Capture failed:", err);
      }
    },
    [captureResolutionOverride, isElectron]
  );

  const copyRecording = async (blob: Blob) => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "video/webm": blob }),
      ]);
    } catch {
      /* clipboard may not support video */
    }
  };

  // Screen share decode: use a single <video> element (`screenVideoRef`) to avoid dual-decoding the same stream,
  // which can trigger global UI jitter (menu bar capture indicator / QuickTime HUD) on macOS.
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

  // Track rect for full-page portal: screen-share → capture preview pane; whiteboard-only → same layer as
  // PiP CSS math + minimap (`previewRef` inset overlay). Using `contentAreaRef` here offset the fixed portal
  // by padding/border vs that layer → PiP “vanished” off the board while the record composite stayed correct.
  useLayoutEffect(() => {
    if (!fullPageWhiteboard || !showPip) {
      portalRectLiveRef.current = null;
      lastPortalRectKeyRef.current = null;
      setPortalRect(null);
      return;
    }
    const el =
      activeScreenStream ? previewRef.current : previewRef.current ?? contentAreaRef.current;
    if (!el) return;
    const rInit = el.getBoundingClientRect();
    portalRectLiveRef.current = rInit;
    lastPortalRectKeyRef.current = `${Math.round(rInit.left)}|${Math.round(rInit.top)}|${Math.round(rInit.width)}|${Math.round(rInit.height)}`;
    setPortalRect(rInit);
    let coalesceRaf = 0;
    const update = () => {
      if (coalesceRaf) return;
      coalesceRaf = requestAnimationFrame(() => {
        coalesceRaf = 0;
        const target =
          activeScreenStream ? previewRef.current : previewRef.current ?? contentAreaRef.current;
        if (!target) return;
        const r = target.getBoundingClientRect();
        portalRectLiveRef.current = r;
        /** Do not auto-scale `fullPagePipPos` from preview ResizeObserver — it fought letterbox/minimap math; stray `setFullPagePipPos` also got mirrored into `fullPagePipPosRef` during recording via the layout effect. */
        contentAreaPrevRectRef.current = { w: r.width, h: r.height };
        const rk = `${Math.round(r.left)}|${Math.round(r.top)}|${Math.round(r.width)}|${Math.round(r.height)}`;
        if (lastPortalRectKeyRef.current !== rk) {
          lastPortalRectKeyRef.current = rk;
          setPortalRect(r);
        }
        // Preview loop already drives drawComposite; calling it here + setState caused ResizeObserver↔render feedback and PiP blink.
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      if (coalesceRaf) cancelAnimationFrame(coalesceRaf);
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
    let mlCoalesce = 0;
    const update = () => {
      if (mlCoalesce) return;
      mlCoalesce = requestAnimationFrame(() => {
        mlCoalesce = 0;
        const e = previewRef.current;
        if (e) setMainLayoutPortalRect(e.getBoundingClientRect());
      });
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
      if (mlCoalesce) cancelAnimationFrame(mlCoalesce);
      ro.disconnect();
      window.removeEventListener("resize", update);
      scrollParent?.removeEventListener("scroll", update);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [fullPageWhiteboard, showPip, activeScreenStream]);

  // Preview loop: PiP overlay canvas + in-app composite. While recording + Capture Screen, still refresh the
  // overlay when the portal is visible (PiP on whiteboard) so beauty/filter/wide-aspect paint does not stall.
  useEffect(() => {
    if (!showPip) return;
    /** Static avatar image is drawn on the overlay canvas (z above video/img); skipping this loop left the canvas blank and hid the image. */
    const pipWantsCameraOverlay =
      !!avatarImageSrc ||
      faceFilter !== "none" ||
      pipEffectBackend === "snap";
    const shouldDrawCameraOverlayCanvas =
      (!(fullPageWhiteboard && activeScreenStream) && outsideForPipOverlay) ||
      (fullPageWhiteboard && activeScreenStream && pipWantsCameraOverlay) ||
      (fullPageWhiteboard && !activeScreenStream && showPip) ||
      (showPip && !activeScreenStream && pipWantsCameraOverlay && !!mainLayoutPortalRect) ||
      (pipWantsCameraOverlay && showPip);
    // Live screen share preview: prefer showing the shared <video> directly (no canvas composite)
    // to reduce GPU/CPU contention that can manifest as global UI flicker (menu bar capture indicator).
    const needsCompositePreview =
      !(fullPageWhiteboard && !activeScreenStream) &&
      !(!isRecording && !!activeScreenStream);
    // When screen sharing and not recording, avoid repainting overlay every rAF unless it actually has effects.
    const shouldDrawOverlayAtAll = !activeScreenStream || isRecording || pipWantsCameraOverlay;
    const drawOverlayWhileRecording =
      shouldDrawCameraOverlayCanvas &&
      (!isRecording ||
        !activeScreenStream ||
        outsideForPipOverlay ||
        (fullPageWhiteboard && activeScreenStream && pipWantsCameraOverlay));
    let id: number;
    const loop = () => {
      const now = performance.now();
      const previewGesturing = previewBoxDraggingRef.current;
      const minStepMs =
        pipDraggingRef.current || wbMiniPipDraggingRef.current
          ? 0
          : previewGesturing
            ? 56
            : isRecording
            ? 48
            : activeScreenStreamRef.current
              ? 96
              : 40;
      if (now - previewLoopLastAtRef.current < minStepMs) {
        id = requestAnimationFrame(loop);
        return;
      }
      previewLoopLastAtRef.current = now;
      if (fullPageWhiteboard) {
        if (shouldDrawOverlayAtAll && drawOverlayWhileRecording) drawCameraOverlayRef.current?.();
        if (!isRecording && needsCompositePreview) drawCompositeRef.current?.();
      } else {
        if (shouldDrawOverlayAtAll && drawOverlayWhileRecording) drawCameraOverlayRef.current?.();
        if (!isRecording && needsCompositePreview) drawCompositeRef.current?.();
      }
      id = requestAnimationFrame(loop);
    };
    previewLoopLastAtRef.current = 0;
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [
    isRecording,
    showPip,
    avatarImageSrc,
    fullPageWhiteboard,
    activeScreenStream,
    faceFilter,
    pipEffectBackend,
    mainLayoutPortalRect,
    outsideForPipOverlay,
    pipDragging,
  ]);

  // Screen share live preview: draw composite on actual video frames (avoids CSS contain rounding jitter with Presenter Overlay).
  useEffect(() => {
    if (!activeScreenStream || isRecording) return;
    const v = screenVideoRef.current;
    if (!v) return;
    let stopped = false;
    let rafId = 0;
    let lastAt = 0;
    const MIN_MS = 1000 / 15;

    const tick = (now: number) => {
      if (stopped) return;
      if (now - lastAt >= MIN_MS) {
        lastAt = now;
        try {
          drawCompositeRef.current?.(false);
        } catch {
          /* ignore draw errors */
        }
      }
      // Prefer requestVideoFrameCallback when available; fallback to rAF.
      if (typeof (v as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function") {
        (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: (now: number) => void) => number }).requestVideoFrameCallback(
          tick
        );
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    // Kick once the video is ready.
    const start = () => tick(performance.now());
    if (v.readyState >= 2) start();
    else v.addEventListener("loadeddata", start, { once: true });

    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      v.removeEventListener("loadeddata", start as EventListener);
    };
  }, [activeScreenStream, isRecording]);

  // Whiteboard-only recording: prefer stacking Excalidraw's on-screen canvases (follows zoom/pan).
  // Fallback: exportToCanvas when composite fails. Scene changes trigger immediate re-export via onSceneChange.
  useEffect(() => {
    if (!isRecording || activeScreenStream) return;
    const res = recordOutputDimensions;
    const exportIntervalMs = 500;

    let cancelled = false;
    let lastSceneVersion = -1;
    let exportSeq = 0;
    let exportBusy = false;

    const doExport = async () => {
      if (exportBusy || cancelled) return;
      exportBusy = true;
      const mySeq = ++exportSeq;
      try {
        await new Promise((r) => requestAnimationFrame(r));
        if (cancelled) return;
        const api = excalidrawAPIRef.current;
        const ver = api ? (getSceneVersion(api.getSceneElements() as never) as unknown as number) : -1;
        const sceneChanged = ver !== lastSceneVersion;

        const wbEl = fullPageContentRef.current;
        const wbW = Math.max(1, wbEl?.offsetWidth ?? res.w);
        const wbH = Math.max(1, wbEl?.offsetHeight ?? res.h);

        if (!wbViewportReuseCanvasRef.current) wbViewportReuseCanvasRef.current = document.createElement("canvas");
        let canvas: HTMLCanvasElement | null = wbEl ? compositeExcalidrawViewportCanvases(wbEl, wbW, wbH, wbViewportReuseCanvasRef.current) : null;

        if (canvas) {
          // Viewport composite succeeded — skip heavy exportToCanvas entirely.
        } else if (api && sceneChanged) {
          try {
            const elements = api.getSceneElements();
            const appState = api.getAppState();
            const files = api.getFiles();
            canvas = await exportToCanvas({
              elements: elements as Parameters<typeof exportToCanvas>[0]["elements"],
              appState: { ...(appState as object), exportWithDarkMode: false } as Parameters<typeof exportToCanvas>[0]["appState"],
              files: files as Parameters<typeof exportToCanvas>[0]["files"],
              maxWidthOrHeight: Math.max(wbW, wbH),
              exportPadding: 0,
            });
          } catch {
            /* ignore */
          }
        } else if (!sceneChanged && whiteboardExportedRef.current) {
          return;
        }

        if (!cancelled && canvas && api && wbEl) {
          try {
            await drawStandaloneEditingTextOverlay(canvas, wbEl, wbW, wbH, api);
          } catch {
            /* overlay is best-effort */
          }
        }

        if (!cancelled && canvas && mySeq === exportSeq) {
          whiteboardExportedRef.current = canvas;
          lastSceneVersion = ver;
        }
      } finally {
        exportBusy = false;
      }
    };

    doExport();
    wbImmediateExportRef.current = doExport;
    const id = window.setInterval(doExport, exportIntervalMs);
    return () => {
      cancelled = true;
      wbImmediateExportRef.current = null;
      clearInterval(id);
      whiteboardExportedRef.current = null;
      wbViewportReuseCanvasRef.current = null;
    };
  }, [isRecording, activeScreenStream, recordOutputDimensions]);


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

  const cameraStreamRef = useRef(cameraStream);
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
      createCircularIcon("./logo.png", 32)
        .then((fav) => {
          setFavicon(fav.dataUrl);
        })
        .catch(() => {
          setFavicon("./logo.png");
        });
      if (isElectron) {
        fetch("./logo.png")
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
    const current = loadSettings();
    saveSettings({
      ...current,
      glowColor,
      pipPos,
      fullPagePipPos,
      sidebarWidth,
      previewWidth,
      whiteboardPanelWidth,
      whiteboardHeight,
      avatarSize,
      avatarShape,
      avatarDecor,
      avatarImageSrc: avatarImageSrc ?? undefined,
      beautyMode,
      beautySettings,
      faceFilter,
      pipEffectBackend,
      recordResolution,
      recordOutputShape,
      shareWindowFillPercent,
      sharePortraitWindowPanNorm,
      whiteboardRecordSurfacePanNorm,
      letterboxBackground,
      letterboxCustomImage: letterboxCustomImage ?? undefined,
      letterboxMode,
      previewPosition,
      previewLayoutMode,
      fullPagePreviewPos: fullPagePreviewPos ?? undefined,
      micVolume,
      systemVolume,
      omitPipFromRecording,
      autoParkPipOnRecordStart,
      settingsPanelGeom,
    });
  }, [
      glowColor,
      pipPos,
      fullPagePipPos,
      sidebarWidth,
      previewWidth,
      whiteboardPanelWidth,
      whiteboardHeight,
      avatarSize,
      avatarShape,
      avatarDecor,
      avatarImageSrc,
      beautyMode,
      beautySettings,
      faceFilter,
      pipEffectBackend,
      recordResolution,
      recordOutputShape,
      shareWindowFillPercent,
      sharePortraitWindowPanNorm,
      whiteboardRecordSurfacePanNorm,
      letterboxBackground,
      letterboxCustomImage,
      letterboxMode,
      previewPosition,
      previewLayoutMode,
      fullPagePreviewPos,
      micVolume,
      systemVolume,
      omitPipFromRecording,
      autoParkPipOnRecordStart,
      settingsPanelGeom,
    ]);

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
    if (pipResizeDraggingRef.current) return;
    if ((e.target as HTMLElement | null)?.closest?.("[data-dreamwork-pip-br-resize]")) return;
    if (pipDraggingRef.current) return;
    const pip = pipRef.current;
    const usePreviewPagePos =
      previewPageContextRef.current && !(fullPageWhiteboard && activeScreenStream);
    const useViewportCoords = !usePreviewPagePos && !!activeScreenStream;
    const container = usePreviewPagePos
      ? previewRef.current
      : activeScreenStream
        ? null
        : previewRef.current ?? contentAreaRef.current;
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
    let wbRecordDragRaf = 0;
    const onMove = (ev: PointerEvent | MouseEvent) => {
      const r = useViewportCoords
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : container!.getBoundingClientRect();
      const { x: ox, y: oy } = pipOffsetRef.current;
      let x = ev.clientX - r.left - ox;
      let y = ev.clientY - r.top - oy;
      if (ev instanceof PointerEvent && ev.getCoalescedEvents) {
        const coalesced = ev.getCoalescedEvents();
        if (coalesced.length > 0) {
          const last = coalesced[coalesced.length - 1];
          x = last.clientX - r.left - ox;
          y = last.clientY - r.top - oy;
        }
      }
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
      // 录制合成读 fullPagePipPosRef：每步更新 ref + DOM；state 仅在 pointerup 同步，避免与直接写的 left/top 争用
      if (fullPageWhiteboard && activeScreenStream) {
        recordingDrawAndDisplayRef.current?.();
      } else if (isRecording && recordingDrawAndDisplayRef.current) {
        if (fullPageWhiteboard && !activeScreenStream) {
          drawCameraOverlayRef.current?.();
          if (wbRecordDragRaf) cancelAnimationFrame(wbRecordDragRaf);
          wbRecordDragRaf = requestAnimationFrame(() => {
            wbRecordDragRaf = 0;
            recordingDrawAndDisplayRef.current?.();
          });
        } else {
          recordingDrawAndDisplayRef.current?.();
        }
      }
    };
    const cleanup = () => {
      setPos(posRef.current);
      document.removeEventListener("pointermove", onMoveP);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("mousemove", onMoveM);
      document.removeEventListener("mouseup", onUp);
      if (wbRecordDragRaf) {
        cancelAnimationFrame(wbRecordDragRaf);
        wbRecordDragRaf = 0;
      }
      pipDraggingRef.current = false;
      setPipDragging(false);
      if (isRecording && recordingDrawAndDisplayRef.current) {
        queueMicrotask(() => {
          drawCameraOverlayRef.current?.();
          recordingDrawAndDisplayRef.current?.();
          requestAnimationFrame(() => {
            drawCameraOverlayRef.current?.();
            recordingDrawAndDisplayRef.current?.();
          });
        });
      }
    };
    const onUp = cleanup;
    const onMoveP = onMove as (ev: PointerEvent) => void;
    const onMoveM = onMove as (ev: MouseEvent) => void;
    document.addEventListener("pointermove", onMoveP);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("mousemove", onMoveM);
    document.addEventListener("mouseup", onUp);
  }, [portalRect, mainLayoutPortalRect, activeScreenStream, avatarSize, fullPageWhiteboard, isRecording]);

  const handlePipResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (pipDraggingRef.current || pipResizeDraggingRef.current) return;
      if (!showPip || avatarImageSrc || !isRecording || !fullPageWhiteboard || activeScreenStream || !cameraStream) {
        return;
      }
      const el = e.currentTarget;
      pipResizeDraggingRef.current = true;
      if (e.pointerId != null && el instanceof HTMLElement && el.setPointerCapture) {
        el.setPointerCapture(e.pointerId);
      }
      const startSize = avatarSize;
      const startClientY = e.clientY;
      let recRaf = 0;
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startClientY;
        const next = Math.min(400, Math.max(32, Math.round(startSize - dy / 2.25)));
        setAvatarSize((prev) => (prev === next ? prev : next));
        drawCameraOverlayRef.current?.();
        if (recordingDrawAndDisplayRef.current) {
          if (recRaf) cancelAnimationFrame(recRaf);
          recRaf = requestAnimationFrame(() => {
            recRaf = 0;
            recordingDrawAndDisplayRef.current?.();
          });
        }
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        try {
          if (e.pointerId != null && el instanceof HTMLElement) el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (recRaf) cancelAnimationFrame(recRaf);
        pipResizeDraggingRef.current = false;
        queueMicrotask(() => {
          drawCameraOverlayRef.current?.();
          recordingDrawAndDisplayRef.current?.();
        });
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [
      showPip,
      avatarImageSrc,
      isRecording,
      fullPageWhiteboard,
      activeScreenStream,
      cameraStream,
      avatarSize,
    ]
  );

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
    if ((e.target as HTMLElement | null)?.closest?.("[data-dreamwork-share-pan]")) return;
    if ((e.target as HTMLElement | null)?.closest?.("[data-dreamwork-pip-br-resize]")) return;
    setContextFromClick(e.clientX, e.clientY);
    const pip = pipRef.current;
    const container = fullPageWhiteboard
      ? (activeScreenStream ? previewRef.current : contentAreaRef.current)
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
    if (!fullPageWhiteboard) return;
    const handleNative = (e: PointerEvent | MouseEvent) => {
      const target = e.target as HTMLElement;
      const el = target?.nodeType === Node.ELEMENT_NODE ? target : (target as Node).parentElement as HTMLElement;
      if (target?.closest?.('[role="dialog"], [data-modal-overlay]')) return;
      // Let header/RecordingControls / Teleprompter (data-dreamwork-no-intercept) handle their own clicks.
      // `target` alone is wrong when a child uses pointer-events-none: the hit falls through to Capture
      // canvas/video beneath the panel, so also check the full stack at this point.
      if (target?.closest?.('[data-dreamwork-no-intercept]')) return;
      /** Radix Select portals to document.body — not under [role="dialog"]; items aren't native <button>s. */
      if (target?.closest?.('[data-slot="select-content"]')) return;
      if (
        typeof e.clientX === "number" &&
        typeof e.clientY === "number" &&
        document.elementsFromPoint(e.clientX, e.clientY).some(
          (node) => node instanceof Element && node.closest?.("[data-dreamwork-no-intercept]"),
        )
      ) {
        return;
      }
      if (
        typeof e.clientX === "number" &&
        typeof e.clientY === "number" &&
        document.elementsFromPoint(e.clientX, e.clientY).some(
          (node) => node instanceof Element && node.closest?.('[data-slot="select-content"]'),
        )
      ) {
        return;
      }
      // Geometric fallback: never intercept clicks in top 100px (header area)
      if (e.clientY < 100) return;
      if (!showPip) return;
      if (pipDraggingRef.current || previewBoxDraggingRef.current || pipResizeDraggingRef.current) return;
      if (
        typeof e.clientX === "number" &&
        typeof e.clientY === "number" &&
        document.elementsFromPoint(e.clientX, e.clientY).some(
          (node) => node instanceof Element && node.closest?.("[data-dreamwork-pip-br-resize]"),
        )
      ) {
        return;
      }
      if (
        typeof e.clientX === "number" &&
        typeof e.clientY === "number" &&
        document.elementsFromPoint(e.clientX, e.clientY).some(
          (node) => node instanceof Element && node.closest?.("[data-dreamwork-share-pan]"),
        )
      ) {
        return;
      }
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
  }, [fullPageWhiteboard, showPip, activeScreenStream, setContextFromClick]);

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

  const headerEl = (
    <header
      data-dreamwork-no-intercept
      className={`glass-panel fixed left-0 right-0 top-0 flex shrink-0 flex-col shadow-sm [&>*]:relative [&>*]:z-10 pointer-events-auto isolate ${
        windowLiveResize ? "transition-none" : "transition-[padding,gap] duration-200 ease-out"
      } ${showLiveMeetingModal ? "z-[100030]" : "z-[999999]"
      } ${isCompact ? "gap-1.5 px-3 py-2" : "gap-2 px-4 py-3"}`}
    >
        <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex shrink-0 items-center gap-2">
              <img
                src={avatarImageSrc ?? "./logo.png"}
                alt="DreamWorks"
                className={`shrink-0 rounded-full object-cover ring-2 ring-white/30 ${
                  windowLiveResize ? "transition-none" : "transition-[width,height] duration-200 ease-out"
                } ${isCompact ? "size-7" : "size-9"}`}
              />
              <h1
                className={`font-semibold tracking-tight truncate ${
                  windowLiveResize ? "transition-none" : "transition-[font-size] duration-200 ease-out"
                } ${isCompact ? "text-sm" : "text-base"}`}
              >
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
            <div className="flex min-w-0 flex-1 items-center justify-between overflow-x-auto overflow-y-hidden gap-3">
              <div className="flex shrink-0 items-center gap-3 min-w-max">
              <RecordingControls
                hasScreen={hasScreen}
                hasCamera={hasCamera}
                isRecording={isRecording}
                isRecordingPaused={isRecordingPaused}
                compact={isCompact}
                recordingDisabled={inLiveMeeting}
                onCaptureScreen={captureScreen}
                onStopScreenShare={stopScreenShare}
                onSwitchSharedCapture={hasScreen ? switchSharedCapture : undefined}
                onToggleCamera={showPip ? stopCamera : startCamera}
                onToggleRecord={toggleRecord}
                onPauseRecording={pauseRecording}
                onResumeRecording={resumeRecording}
                onOpenFullPageWhiteboard={handleHeaderWhiteboardLayout}
                whiteboardEmphasis={!hasScreen || preferWhiteboardMain}
                onOpenLiveMeeting={() => setShowLiveMeetingModal(true)}
                onToggleTeleprompter={handleToggleTeleprompter}
                onCaptureScreenshot={captureScreenshot}
                showWhiteboard={true}
                showTeleprompter={showTeleprompter}
                recordingTimeLabel={formatRecordingTime(recordingTime)}
                showParkPip={fullPageWhiteboard && hasCamera}
                onParkPipOnWhiteboard={parkPipOnWhiteboard}
              />
              </div>
              {!isCompact && (
                <div className="sector-card flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-[8px] font-semibold">
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
              )}
            </div>
          </div>
        </header>
  );

  /** Split affordance hints: narrow pane → show fade (see SplitAffordanceHint). */
  const contentWForSplit =
    contentAreaSplitWidth > 0
      ? contentAreaSplitWidth
      : (contentAreaRef.current?.offsetWidth ?? contentAreaPrevRectRef.current?.w ?? 0);
  const contentWBase =
    splitAffordanceLive?.content ??
    (contentWForSplit > 0 ? contentWForSplit : (contentAreaRef.current?.offsetWidth ?? 0));
  const stripBase = splitAffordanceLive
    ? splitAffordanceLive.strip
    : Math.max(SPLIT_STRIP_MIN_PX, Math.round(whiteboardPanelWidth));
  const stripPxForGrid =
    splitMainIsCapture && hasScreen
      ? stripBase
      : splitMainIsCapture && !hasScreen
        ? SPLIT_STRIP_MIN_PX
        : stripBase;
  const whiteboardTrackW = splitMainIsCapture
    ? stripPxForGrid
    : Math.max(0, contentWBase - 14 - stripBase);
  /** Width of the Capture column (shows screen share): right strip when no stream, flex remainder when sharing. */
  const captureColumnW =
    contentWBase > 0
      ? splitMainIsCapture
        ? Math.max(0, contentWBase - 14 - stripPxForGrid)
        : stripBase
      : 0;
  const stripAtMin =
    (splitMainIsCapture ? stripPxForGrid : stripBase) <= SPLIT_STRIP_MIN_PX;
  const captureAtMin = captureColumnW > 0 && captureColumnW <= SPLIT_STRIP_MIN_PX;
  const whiteboardColumnW = splitMainIsCapture ? stripPxForGrid : whiteboardTrackW;
  const showExcalidrawAffordance =
    whiteboardColumnW > 0 && whiteboardColumnW < SPLIT_COLUMN_MIN_USABLE_PX;
  /** No stream: always show capture CTA (button or drag-only under min width). With stream: only when capture column is narrow (drag affordance). */
  const showScreenAffordance =
    !hasScreen || (hasScreen && captureColumnW > 0 && captureColumnW < SPLIT_COLUMN_MIN_USABLE_PX);
  const captureColumnTooNarrowForCaptureCta =
    captureColumnW > 0 && captureColumnW < SPLIT_COLUMN_MIN_USABLE_PX;

  const splitGridFallback = splitGridTemplate(stripPxForGrid, splitMainIsCapture);

  /** Slim UI lives in a dedicated Electron window — do not duplicate in the main webview. */
  const teleprompterSlimInOwnBrowserWindow = isElectron && teleprompterSlimMode;

  return (
    <>
      {typeof document !== "undefined" && createPortal(headerEl, document.getElementById("dreamwork-header-root") ?? document.body)}
      <TeleprompterErrorBoundary
        onCrash={() => {
          setShowTeleprompter(false);
          setTeleprompterPlaying(false);
          setTeleprompterFollowMode(false);
          setTeleprompterSlimMode(false);
        }}
      >
        <TeleprompterOverlay
          isVisible={
            showTeleprompter &&
            (!detachedHelpersEnabled || teleprompterSlimMode) &&
            !teleprompterSlimInOwnBrowserWindow
          }
          script={teleprompterScript}
          isPlaying={teleprompterPlaying}
          speed={teleprompterSpeed}
          fontSize={teleprompterFontSize}
          opacity={teleprompterOpacity}
          overlayWidth={teleprompterWidth}
          overlayHeight={teleprompterHeight}
          nearCamera={teleprompterNearCamera}
          anchorRect={teleprompterAnchorRect}
          dockColumnRect={null}
          position={teleprompterPosition}
          muteVoskForDetachedHelper={
            (detachedHelpersEnabled && !teleprompterSlimMode) || teleprompterSlimInOwnBrowserWindow
          }
          locked={teleprompterLocked}
          resetSignal={teleprompterResetSeq}
          editorScrollRatio={teleprompterEditorScrollRatio}
          followMode={teleprompterFollowMode}
          onSetFollowMode={setTeleprompterFollowMode}
          slimMode={teleprompterSlimMode}
          onSetSlimMode={setTeleprompterSlimMode}
          onSetPlaying={setTeleprompterPlaying}
          onPositionChange={setTeleprompterPosition}
          onOverlaySizeChange={(w, h) => {
            setTeleprompterWidth(w);
            setTeleprompterHeight(h);
          }}
          onDragStart={() => setTeleprompterNearCamera(false)}
          onToggleLocked={handleToggleTeleprompterLock}
          onReset={handleResetTeleprompter}
          onHide={() => {
            setShowTeleprompter(false);
            setTeleprompterPlaying(false);
            setTeleprompterFollowMode(false);
            setTeleprompterSlimMode(false);
          }}
          onNudgeSpeed={(delta) => setTeleprompterSpeed((prev) => Math.max(10, Math.min(80, prev + delta)))}
          voskLang={teleprompterVoskLang}
          followScriptIdentity={activeTeleprompterScriptId}
        />
        <TeleprompterPanel
          isVisible={showTeleprompter}
          isPlaying={teleprompterPlaying}
          script={teleprompterScript}
          scripts={teleprompterScripts}
          activeScriptId={activeTeleprompterScriptId}
          onSwitchScript={handleSwitchTeleprompterScript}
          onNewScript={handleNewTeleprompterScript}
          onImportScripts={handleImportTeleprompterScripts}
          onSaveAsScript={handleSaveAsTeleprompterScript}
          onRenameScript={handleRenameTeleprompterScript}
          speed={teleprompterSpeed}
          fontSize={teleprompterFontSize}
          opacity={teleprompterOpacity}
          overlayWidth={teleprompterWidth}
          nearCamera={teleprompterNearCamera}
          locked={teleprompterLocked}
          position={teleprompterPanelPosition}
          panelWidth={teleprompterPanelWidth}
          panelHeight={teleprompterPanelHeight}
          onPanelSizeChange={(w, h) => {
            setTeleprompterPanelWidth(w);
            setTeleprompterPanelHeight(h);
          }}
          onSetScript={handleSetTeleprompterScript}
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
            setTeleprompterFollowMode(false);
            setTeleprompterSlimMode(false);
          }}
          onEditorScroll={(ratio) => {
            setTeleprompterEditorScrollRatio(ratio);
            setTeleprompterPlaying(false);
          }}
          onFlushSave={flushTeleprompterSave}
          followMode={teleprompterFollowMode}
          onSetFollowMode={setTeleprompterFollowMode}
          voskLang={teleprompterVoskLang}
          onSetVoskLang={setTeleprompterVoskLang}
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
              ref={liveMeetingRef}
              isOpen={showLiveMeetingModal}
              onClose={() => {
                setShowLiveMeetingModal(false);
                setInLiveMeeting(false);
              }}
              onEnterCall={() => {
                setInLiveMeeting(true);
                if (isRecording) stopRecording();
              }}
              onLeaveCall={() => setInLiveMeeting(false)}
            />
          </Suspense>
        </LiveMeetingErrorBoundary>
      )}
      {/* (Removed) Persistent screen video: dual-decoding caused global jitter on macOS window capture. */}
      {/* Persistent camera source: keep active during recording to avoid decode drops (readyState=0 flashes). */}
      {showCameraSourceVideo && (
      <video
        ref={cameraSourceVideoRef}
        autoPlay
        muted
        playsInline
        className="fixed pointer-events-none overflow-hidden object-contain bg-black"
        style={{
          left: fullPageWhiteboard ? -9999 : cameraViewportPos.x,
          top: fullPageWhiteboard ? -9999 : cameraViewportPos.y,
          width: fullPageWhiteboard ? CAMERA_SOURCE_VIDEO_BOX_PX : avatarWidthDisplay,
          height: fullPageWhiteboard ? CAMERA_SOURCE_VIDEO_BOX_PX : avatarHeightDisplay,
          zIndex: fullPageWhiteboard ? -1 : 99990,
          transform: "translate3d(0,0,0)",
          borderRadius: avatarShape === "circle" ? "50%" : AVATAR_RECT_RADIUS,
          /* opacity:0 avoids “almost transparent” layers (0.001) that sporadically composite wrong on Electron */
          opacity: 0,
        }}
        onLoadedMetadata={() => {
          setTimeout(() => {
            cameraSourceVideoRef.current?.play().catch(() => {});
          }, 50);
        }}
        aria-hidden
      />
      )}
      <div
        className={`glass-bg flex h-full min-h-0 w-full min-w-0 flex-col px-4 pb-4 ${showOutput && recordedClips.length > 0 ? "overflow-y-auto overscroll-y-contain" : "overflow-hidden"}`}
      >
        {/* Spacer = header height + padding; use 86px always to avoid layout shift when recording starts */}
        <div className="shrink-0 h-[86px]" aria-hidden />
        {captureError && (
          <div
            role="alert"
            className={`dreamwork-capture-error-banner shrink-0 mx-4 mb-2 rounded-xl border border-red-500/20 bg-gradient-to-b from-red-500/12 to-red-500/8 px-4 py-2.5 text-sm text-red-700 shadow-sm backdrop-blur-[2px] transition-[opacity,transform,filter] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
              captureErrorExiting
                ? "pointer-events-none opacity-0 -translate-y-1 scale-[0.995] blur-[0.5px]"
                : "opacity-100 translate-y-0 scale-100 blur-0"
            }`}
          >
            {captureError}
          </div>
        )}
        {displayMediaPicker && displayMediaPicker.length > 0 &&
          createPortal(
            (() => {
              const list = displayMediaPicker;
              const screenSources = list.filter((s) => String(s.id).startsWith("screen:"));
              const windowSources = list.filter((s) => !String(s.id).startsWith("screen:"));
              const api = (
                window as unknown as {
                  electronAPI?: {
                    displayMediaPick?: (id: string) => Promise<boolean>;
                    displayMediaCancel?: () => Promise<void>;
                  };
                }
              ).electronAPI;
              const pick = (id: string) => {
                void (async () => {
                  await api?.displayMediaPick?.(id);
                  setDisplayMediaPicker(null);
                })();
              };
              const cancel = () => {
                void (async () => {
                  await api?.displayMediaCancel?.();
                  setDisplayMediaPicker(null);
                })();
              };
              const meetCard = (s: (typeof list)[number]) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pick(s.id)}
                  className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/50 bg-white/50 text-left shadow-sm backdrop-blur-sm transition hover:border-neutral-300/80 hover:bg-white/80 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400/80"
                >
                  {/* 16:9 box — object-contain avoids stretching non-wide thumbnails */}
                  <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-t-[10px] bg-black/15">
                    {s.thumbnailDataUrl ? (
                      <img
                        src={s.thumbnailDataUrl}
                        alt=""
                        decoding="async"
                        className="absolute inset-0 m-auto h-full w-full max-h-full max-w-full object-contain object-center [image-rendering:auto]"
                      />
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center text-[10px] font-medium text-[#5f6368]">
                        {String(s.id).startsWith("screen:") ? "Screen" : "Window"}
                      </div>
                    )}
                  </div>
                  <div className="line-clamp-2 px-2 py-2 text-center text-[11px] font-medium leading-snug text-neutral-800">
                    {s.name}
                  </div>
                </button>
              );
              const gridClass =
                "grid grid-cols-1 gap-3 min-[440px]:grid-cols-2 min-[720px]:grid-cols-3 min-[1024px]:grid-cols-4";
              return (
                <div
                  data-dreamwork-no-intercept
                  className="dreamwork-display-picker-backdrop fixed inset-0 z-[1000020] flex items-center justify-center bg-violet-950/16 p-4 backdrop-blur-md sm:p-8"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Choose full display or a single window"
                  style={{
                    fontFamily: "Roboto, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
                  }}
                >
                  <div className="dreamwork-display-picker-panel flex max-h-[min(90vh,840px)] w-full max-w-[min(96vw,1100px)] flex-col overflow-hidden rounded-2xl border border-violet-200/50 bg-gradient-to-br from-[#f5f3ff]/88 via-[#efeffb]/90 to-[#ede9fe]/88 shadow-[0_24px_80px_rgba(76,29,149,0.2)] backdrop-blur-2xl backdrop-saturate-150">
                    <div className="border-b border-violet-200/40 px-6 py-4">
                      <h2 className="text-[1.125rem] font-semibold tracking-tight text-neutral-950">
                        Share your screen
                      </h2>
                      <p className="mt-1 text-[0.8125rem] text-neutral-600">
                        Choose a full monitor or a single window.
                      </p>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">
                      {screenSources.length > 0 && (
                        <section className="mb-6">
                          <h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wide text-neutral-700">
                            Full display (entire monitor)
                          </h3>
                          <div className={gridClass}>{screenSources.map(meetCard)}</div>
                        </section>
                      )}
                      {windowSources.length > 0 && (
                        <section>
                          <h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wide text-neutral-700">
                            A single window
                          </h3>
                          <div className={gridClass}>{windowSources.map(meetCard)}</div>
                        </section>
                      )}
                    </div>
                    <div className="flex justify-end gap-2 border-t border-violet-200/40 bg-violet-100/30 px-5 py-3.5 backdrop-blur-md sm:px-6">
                      <button
                        type="button"
                        onClick={cancel}
                        className="rounded-lg border border-neutral-200/80 bg-white/70 px-4 py-2 text-[0.875rem] font-medium text-neutral-900 shadow-sm backdrop-blur-sm hover:bg-white/95"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              );
            })(),
            document.body
          )}
        {showSettings &&
          createPortal(
            <SettingsFloatingPanel
              open={showSettings}
              onClose={() => setShowSettings(false)}
              geom={settingsPanelGeom}
              onGeomChange={setSettingsPanelGeom}
              title="Settings"
              titleId="dreamwork-settings-title"
              zClassName={Z_SETTINGS_PANEL}
            >
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
                pipEffectBackend={pipEffectBackend}
                onPipEffectBackendChange={setPipEffectBackend}
                snapCameraKitOptionAvailable={snapCameraKitEnvConfigured()}
                micVolume={micVolume}
                onMicVolumeChange={setMicVolume}
                systemVolume={systemVolume}
                onSystemVolumeChange={setSystemVolume}
                recordResolution={recordResolution}
                onRecordResolutionChange={setRecordResolution}
                recordOutputShape={recordOutputShape}
                onRecordOutputShapeChange={setRecordOutputShape}
                shareWindowFillPercent={shareWindowFillPercent}
                onShareWindowFillPercentChange={setShareWindowFillPercent}
                letterboxBackground={letterboxBackground}
                onLetterboxBackgroundChange={setLetterboxBackground}
                letterboxCustomImage={letterboxCustomImage}
                onLetterboxCustomImageChange={setLetterboxCustomImage}
                letterboxMode={letterboxMode}
                onLetterboxModeChange={setLetterboxMode}
                omitPipFromRecording={omitPipFromRecording}
                onOmitPipFromRecordingChange={setOmitPipFromRecording}
                autoParkPipOnRecordStart={autoParkPipOnRecordStart}
                onAutoParkPipOnRecordStartChange={setAutoParkPipOnRecordStart}
              />
            </SettingsFloatingPanel>,
            document.body
          )}
        {/* overflow-visible so Excalidraw hamburger MainMenu is not clipped at the bottom (nested overflow:hidden was cutting the dropdown). */}
        <div ref={contentAreaRef} className="relative z-0 flex flex-1 min-h-0 min-w-0 gap-0 isolation-isolate overflow-visible rounded-xl">
          {/* Composite overlay: always render when whiteboard-only so compositeRef exists for recording (avoids black screen) */}
          {!activeScreenStream && (
            <div
              ref={previewRef}
              className={`absolute inset-0 pointer-events-none overflow-hidden rounded-xl ${fullPageWhiteboard && !activeScreenStream ? "invisible z-0" : "z-30"}`}
              onPointerDownCapture={handlePreviewPointerDown}
            >
              <canvas
                ref={compositeRef}
                className="absolute inset-0 w-full h-full pointer-events-none"
              />
              {showPip && (
              <div
                ref={wbPreviewPipHitRef}
                className="absolute z-10 cursor-grab touch-none pointer-events-auto"
                style={{
                  left: Math.max(0, fullPagePipForRender.x),
                  top: Math.max(0, fullPagePipForRender.y),
                  width: avatarWidthDisplay,
                  height: avatarHeightDisplay,
                  touchAction: "none",
                }}
                onMouseDown={handlePipMouseDown}
                onPointerDown={(e) => handlePipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
                aria-label="Drag to move camera"
              />
              )}
              {showPip && isRecording && fullPageWhiteboard && !activeScreenStream && !avatarImageSrc && (
                <div
                  ref={wbPreviewPipBrHitRef}
                  data-dreamwork-pip-br-resize=""
                  className="absolute z-[11] touch-none pointer-events-auto"
                  style={{
                    left: Math.max(0, fullPagePipForRender.x) + avatarWidthDisplay - PIP_BR_RESIZE_HANDLE_PX,
                    top: Math.max(0, fullPagePipForRender.y) + avatarHeightDisplay - PIP_BR_RESIZE_HANDLE_PX,
                    width: PIP_BR_RESIZE_HANDLE_PX,
                    height: PIP_BR_RESIZE_HANDLE_PX,
                    cursor: "nwse-resize",
                  }}
                  title="拖拽调整摄像头大小"
                  aria-label="Resize camera"
                  onPointerDown={(e) => handlePipResizePointerDown(e as unknown as React.PointerEvent)}
                />
              )}
            </div>
          )}
          {/* Tri-pane: CSS Grid — 1fr on capture when `splitMainIsCapture` (see splitGridFallback). */}
          <div
            ref={splitTriPaneRef}
            data-dw-split-capture-main={splitMainIsCapture ? "" : undefined}
            className="grid min-h-0 min-w-0 w-full flex-1 [grid-template-rows:minmax(0,1fr)]"
            style={{
              gridTemplateColumns: splitGridFallback,
              ["--dreamwork-strip-px" as string]: `${stripPxForGrid}px`,
            }}
          >
            {/* Whiteboard: main when no screen, mini strip when screen selected */}
            <div
              ref={fullPageContentRef}
              className={`relative z-10 flex h-full min-h-0 min-w-0 overflow-hidden sector-card bg-white ${
                splitMainIsCapture ? "box-border min-w-0" : "pr-1"
              } ${hasScreen && windowLiveResize ? "transition-none" : ""} ${
                screenShareStopPhase === "restoring" && !activeScreenStream ? "dreamwork-whiteboard-restore-in" : ""
              }`}
              style={{
                gridColumn: "1 / 2",
                gridRow: "1 / 2",
                ...(splitMainIsCapture
                  ? {
                      boxSizing: "border-box",
                      width: `${stripPxForGrid}px`,
                      minWidth: SPLIT_STRIP_MIN_PX,
                      maxWidth: `${stripPxForGrid}px`,
                    }
                  : {}),
                // View Transitions API — smooth cross-fade when swapping main column with screen share
                ...( { viewTransitionName: "dreamwork-wb-pane" } as React.CSSProperties),
              }}
            >
              {/* Excalidraw must never unmount when the strip is minimized — scene + undo stack must survive. */}
              {/* overflow-hidden + transform: 裁剪浮动工具栏/底栏，避免画进右侧 Capture；transform 让内部 position:fixed 相对本层，便于一起裁剪 */}
              <div className="absolute inset-0 z-[1] min-h-0 min-w-0 isolate overflow-hidden rounded-xl [transform:translateZ(0)]">
                <ExcalidrawBoard
                  settingsSyncEpoch={electronSettingsEpoch}
                  onCanvasLayersChange={handleWhiteboardLayersChange}
                  onWhiteboardTextureChange={handleWhiteboardTextureChange}
                  onExcalidrawReady={handleExcalidrawReady}
                  onSceneChange={handleWhiteboardSceneChange}
                />
              </div>
              <SplitAffordanceHint
                show={showExcalidrawAffordance}
                variant="excalidraw"
                minStrip={!!splitMainIsCapture && stripAtMin}
                preferDragAffordance={showExcalidrawAffordance}
              />
            </div>
            <ResizeHandle
              direction="horizontal"
              className={`relative z-20 shrink-0 [grid-column:2/3] transition-opacity duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
                isRecording && !activeScreenStream ? "invisible" : ""
              } ${screenShareStopPhase === "exiting" && activeScreenStream ? "pointer-events-none opacity-0" : "opacity-100"}`}
              data-dreamwork-no-intercept
              onResize={() => {}}
              onResizeSessionStart={handleSplitResizeSessionStart}
              onResizeHorizontalClientX={handleMainPanelResizeFromClientX}
              onResizeEnd={handleMainPanelResizeEnd}
              onResizePointerDone={handleSplitResizePointerDone}
            />
            {/* Capture Screen: main when screen selected, mini (40px bar) when whiteboard-only */}
            <div
              ref={hasScreen ? previewRef : screenMiniStripRef}
              data-dreamwork-fixed-strip={!hasScreen ? "" : undefined}
              className={`relative box-border flex min-h-0 min-w-0 max-w-full overflow-hidden rounded-2xl bg-slate-900 transition-[opacity,transform,filter] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
                hasScreen
                  ? isLandscapeRecordOutputShape(recordOutputShape)
                    ? "border-2 border-black"
                    : "border-0 ring-1 ring-inset ring-slate-600/80"
                  : "border-2 border-black"
              } ${
                hasScreen ? "min-w-0" : ""
              } ${
                screenShareStopPhase === "exiting" && activeScreenStream
                  ? "pointer-events-none scale-[0.985] opacity-0 blur-[2px]"
                  : ""
              }`}
              style={{
                boxSizing: "border-box",
                gridColumn: "3 / 4",
                gridRow: "1 / 2",
                width: "100%",
                minWidth: 0,
                maxWidth: "100%",
                ...( { viewTransitionName: "dreamwork-capture-pane" } as React.CSSProperties),
              }}
              onPointerDownCapture={handlePreviewPointerDown}
            >
              {/* Clip video only — base = output-aspect mat inside cell; target = Share% of base (uniform). */}
              {/* NOTE: inner clip edge (overflow/rounded) caused an extra “frame line” + jitter with Presenter Overlay. */}
              <div className="absolute inset-0 z-[1] flex min-h-0 min-w-0 items-center justify-center">
                <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col items-center justify-center">
                  {/* Letterbox background for live preview (canvas composite draws it only while recording). */}
                  <div
                    className="pointer-events-none absolute inset-0 z-0 h-full w-full"
                    style={{
                      backgroundColor: letterboxBackground === "black" ? "#000000" : "#000000",
                      backgroundImage:
                        letterboxBackground === "custom" && letterboxCustomImage
                          ? `url(${letterboxCustomImage})`
                          : undefined,
                      backgroundRepeat: "no-repeat",
                      backgroundPosition: "center",
                      backgroundSize:
                        letterboxMode === "fit"
                          ? "contain"
                          : letterboxMode === "crop"
                            ? "cover"
                            : "cover",
                    }}
                    aria-hidden
                  />
                  {activeScreenStream && (
                    <div className="pointer-events-none absolute inset-0 z-[2] flex min-h-0 min-w-0 items-center justify-center">
                      <div className="relative shrink-0">
                        <canvas
                          ref={compositeRef}
                          className="pointer-events-none block max-h-full max-w-full shrink-0"
                          style={{ visibility: "visible" }}
                        />
                        <div
                          data-dreamwork-share-pan
                          role="presentation"
                          className="pointer-events-auto absolute inset-0 z-[4] cursor-grab touch-none active:cursor-grabbing"
                          style={{ touchAction: "none" }}
                          title="拖拽移动分享窗口；拖拽分享窗口四角调整 Share%。双击居中"
                          onPointerDown={handleSharePortraitPanPointerDown}
                          onPointerMove={handleSharePortraitPanPointerMove}
                          onPointerUp={handleSharePortraitPanPointerUp}
                          onPointerCancel={handleSharePortraitPanPointerUp}
                          onDoubleClick={handleSharePortraitPanDoubleClick}
                          ref={sharePanOverlayRef}
                        />
                      </div>
                    </div>
                  )}
                  {/* Screen-share video element: single decode source. Canvas draws it for live preview. */}
                  <video
                    ref={screenVideoRef}
                    className={`pointer-events-none absolute inset-0 z-[1] h-full w-full object-contain ${
                      activeScreenStream ? "opacity-0" : "opacity-0"
                    }`}
                    autoPlay
                    muted
                    playsInline
                    onLoadedData={() => drawComposite()}
                    aria-hidden
                  />
                </div>
              </div>
              <SplitAffordanceHint
                show={showScreenAffordance}
                variant="screen"
                minStrip={captureAtMin}
                screenShareActive={hasScreen && !splitMainIsCapture}
                preferDragAffordance={captureColumnTooNarrowForCaptureCta}
                screenLayout={splitMainIsCapture ? "main" : "strip"}
                onCaptureScreen={() => void captureScreen()}
              />
              {/* PiP drag for non–full-page-WB screen layouts; full-page WB + screen uses body portal only */}
              {showPip && !(fullPageWhiteboard && activeScreenStream) && (
                <div
                  className="absolute z-10 cursor-grab touch-none"
                  style={{
                    left: Math.max(0, fullPagePipForRender.x),
                    top: Math.max(0, fullPagePipForRender.y),
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
          </div>
          {/* Camera: portal to body - always when showPip, offset in Capture Screen mode */}
          {showPip && fullPageWhiteboard && (cameraStream || avatarImageSrc) &&
            createPortal(
              <div
                style={{
                  position: "fixed",
                  left: activeScreenStream
                    ? fullPagePipForRender.x + CAMERA_OFFSET
                    : (wbPipPortalColumnRect?.left ?? 0) + fullPagePipForRender.x,
                  top: activeScreenStream
                    ? fullPagePipForRender.y + CAMERA_OFFSET
                    : (wbPipPortalColumnRect?.top ?? 0) + fullPagePipForRender.y,
                  width: avatarWidthDisplay,
                  height: avatarHeightDisplay,
                  zIndex: showSettings ? Z_PIP_PORTAL_SETTINGS : Z_PIP_PORTAL,
                  borderRadius: avatarShape === "circle" ? "50%" : AVATAR_RECT_RADIUS,
                  backgroundColor: "#000",
                  boxShadow: activeScreenStream && !isRecording ? "0 4px 16px rgba(0,0,0,0.2)" : "none",
                  /* Recording + Capture: hide video via pipPortalVisualRef (drawComposite), not root opacity — keeps drag hit target. */
                  ...(isRecording && activeScreenStream ? {} : { opacity: 1 }),
                  pointerEvents: "auto",
                  outline: "none",
                  transform: "translateZ(0)",
                }}
                ref={pipRef}
              >
                <div ref={pipPortalVisualRef} className="absolute inset-0 z-[9998] min-h-0 min-w-0">
                  {/* Capture Screen: skip mount-by-outside overlay — mounting here caused boundary blink. Face filter still needs canvas. */}
                  {portalCameraEdgeOnOverlay && (
                    <canvas
                      key={`overlay-${avatarShape}-${avatarDecor}-${avatarWidthDisplay}-${avatarHeightDisplay}`}
                      ref={cameraOverlayRef}
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      style={{
                        borderRadius: avatarShape === "circle" ? "50%" : AVATAR_RECT_RADIUS,
                        zIndex: 10000,
                      }}
                    />
                  )}
                  {snapPipPortalLayer}
                  <CircularWebcam
                    hidden={pipEffectBackend === "snap" && !avatarImageSrc}
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
                    suppressHeavyShadow={isRecording && wbOnlyUi}
                    edgeDecorHandledByOverlay={portalCameraEdgeOnOverlay}
                    onAvatarImageLoad={() => drawCameraOverlayRef.current?.()}
                  />
                </div>
                {/* Drag layer after webcam so it receives pointers while recording */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    cursor: "grab",
                    zIndex: 10002,
                    borderRadius: avatarShape === "circle" ? "50%" : undefined,
                  }}
                  onMouseDown={handlePipMouseDown}
                  onPointerDown={(e) => handlePipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
                  aria-label="Drag to move camera"
                />
                {isRecording && wbOnlyUi && !avatarImageSrc && (
                  <div
                    data-dreamwork-pip-br-resize=""
                    className="absolute touch-none rounded-br-lg"
                    style={{
                      right: 0,
                      bottom: 0,
                      width: PIP_BR_RESIZE_HANDLE_PX,
                      height: PIP_BR_RESIZE_HANDLE_PX,
                      zIndex: 10003,
                      cursor: "nwse-resize",
                      borderBottomRightRadius: avatarShape === "circle" ? "50%" : undefined,
                    }}
                    title="拖拽调整摄像头大小"
                    aria-label="Resize camera"
                    onPointerDown={(e) => handlePipResizePointerDown(e as unknown as React.PointerEvent)}
                  />
                )}
              </div>,
              document.body
            )}
          {typeof document !== "undefined" &&
            isRecording &&
            fullPageWhiteboard &&
            !activeScreenStream &&
            wbMiniPipMinimapUsable &&
            createPortal(
              <WbRecordLayoutMinimapPanel
                outW={recordOutputDimensions.w}
                outH={recordOutputDimensions.h}
                pipMapW={wbRecordMinimapPipMap.pipMapW}
                pipMapH={wbRecordMinimapPipMap.pipMapH}
                pipX={fullPagePipForRender.x}
                pipY={fullPagePipForRender.y}
                pipWCss={avatarWidthDisplay}
                pipHCss={avatarHeightDisplay}
                iw={wbMiniLayoutSnap.iw}
                ih={wbMiniLayoutSnap.ih}
                sharePercent={shareWindowFillPercent}
                surfacePanNorm={whiteboardRecordSurfacePanNorm}
                expanded={wbLayoutMiniExpanded}
                onExpandedChange={setWbLayoutMiniExpanded}
                onPipLive={onWbMiniPipLive}
                onPipMiniDragActive={onWbMiniPipMiniDragActive}
                onPipChange={onWbMiniPipCommit}
                onSurfacePanChange={(p) => {
                  setWhiteboardRecordSurfacePanNorm(p);
                  drawCompositeRef.current?.();
                }}
                onSharePercentLive={onWbMiniSharePctLive}
                onSharePercentChange={onWbMiniSharePctCommit}
                layoutSyncTick={wbMiniPipLayoutTick}
                getPipMapCssSize={getWbMinimapPipMapCssSize}
              />,
              document.body
            )}
        </div>
        {showOutput && recordedClips.length > 0 && !isRecording && (
          <>
            {!outputCollapsed && (
              <ResizeHandle direction="vertical" onResize={handleOutputResize} />
            )}
            <div
              className="glass-panel mx-4 mb-4 flex shrink-0 flex-col overflow-hidden rounded-xl transition-[height] duration-200 ease-out cursor-pointer"
              style={{
                height: outputCollapsed ? OUTPUT_COLLAPSED_HEIGHT : outputHeight,
              }}
              onClick={() => {
                if (outputCollapsed) {
                  if (outputHoverExpandTimerRef.current) {
                    clearTimeout(outputHoverExpandTimerRef.current);
                    outputHoverExpandTimerRef.current = null;
                  }
                  setOutputCollapsed(false);
                }
              }}
              onMouseEnter={() => {
                if (outputIdleTimerRef.current) {
                  clearTimeout(outputIdleTimerRef.current);
                  outputIdleTimerRef.current = null;
                }
                if (outputCollapsed) {
                  if (outputHoverExpandTimerRef.current) return;
                  outputHoverExpandTimerRef.current = window.setTimeout(() => {
                    outputHoverExpandTimerRef.current = null;
                    setOutputCollapsed(false);
                  }, OUTPUT_HOVER_EXPAND_MS);
                }
              }}
              onMouseLeave={() => {
                if (outputHoverExpandTimerRef.current) {
                  clearTimeout(outputHoverExpandTimerRef.current);
                  outputHoverExpandTimerRef.current = null;
                }
                if (!outputCollapsed) {
                  outputIdleTimerRef.current = window.setTimeout(() => {
                    outputIdleTimerRef.current = null;
                    setOutputCollapsed(true);
                  }, OUTPUT_IDLE_MS);
                }
              }}
            >
              <div className="flex h-full flex-col gap-4 overflow-auto p-4">
                {outputCollapsed ? (
                  <div className="flex flex-1 items-center justify-center">
                    <span className="text-xs text-muted-foreground">
                      {recordedClips.length}/3 clips — click or hover 3s to expand
                    </span>
                  </div>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
