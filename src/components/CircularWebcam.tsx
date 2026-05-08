import { useEffect, useRef, useState } from "react";
import type { AvatarShape, AvatarDecor } from "./SettingsPanel";

/** Match App.tsx — widescreen / Presenter-style camera: letterbox in PiP instead of aggressive cover crop */
const PIP_VIDEO_CONTAIN_MIN_ASPECT = 1.42;
/** Hysteresis: avoid object-cover ↔ object-contain flipping when reported aspect hovers near threshold (Capture Screen PiP blink). */
const PIP_WIDE_ASPECT_ON = 1.5;
const PIP_WIDE_ASPECT_OFF = 1.34;

/** Match App.tsx AVATAR_RECT_RADIUS - must stay in sync for corner alignment */
const AVATAR_RECT_RADIUS = 16;

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

interface CircularWebcamProps {
  hidden?: boolean;
  /** When true, hide the video so canvas composite shows through */
  forceCanvasDisplay?: boolean;
  /** When true, don't render video - external ref (e.g. persistent video) is used for drawing */
  useExternalVideo?: boolean;
  /** When true, draw video to canvas for display (fixes WebView video rendering) */
  useCanvasForDisplay?: boolean;
  /** When useCanvasForDisplay, draw from this video ref (e.g. hidden video in main DOM) */
  externalVideoRef?: React.RefObject<HTMLVideoElement | null>;
  /** When true with useCanvasForDisplay, display via img (toDataURL) - workaround for WebView canvas */
  useImgForDisplay?: boolean;
  /** Camera stream - set directly so video works when component mounts in any layout */
  cameraStream?: MediaStream | null;
  /** Width and height for the avatar (rect=landscape, circle=square) */
  avatarWidth: number;
  avatarHeight: number;
  avatarShape: AvatarShape;
  avatarDecor: AvatarDecor;
  glowColor: string;
  beautyMode: boolean;
  beautyFilter: string;
  avatarImageSrc: string | null;
  pipPos: { x: number; y: number };
  onPipMouseDown: (e: React.MouseEvent) => void;
  pipRef: React.RefObject<HTMLDivElement | null>;
  cameraVideoRef?: React.Ref<HTMLVideoElement | null>;
  avatarImgRef: React.RefObject<HTMLImageElement | null>;
  /** 拖动时关掉外层大发光，减轻合成拖影 */
  suppressHeavyShadow?: boolean;
  /** When parent paints avatar edge (stroke/glow) on an overlay canvas, hide duplicate borders here to avoid ghosting */
  edgeDecorHandledByOverlay?: boolean;
  /** After PiP static image loads, parent can repaint overlay canvas (same frame as img.complete). */
  onAvatarImageLoad?: () => void;
}

export function CircularWebcam({
  hidden,
  forceCanvasDisplay = false,
  useExternalVideo: _useExternalVideo = false,
  useCanvasForDisplay = false,
  useImgForDisplay = false,
  externalVideoRef,
  cameraStream,
  avatarWidth,
  avatarHeight,
  avatarShape,
  avatarDecor,
  glowColor,
  beautyMode,
  beautyFilter,
  avatarImageSrc,
  pipPos,
  onPipMouseDown,
  pipRef,
  cameraVideoRef,
  avatarImgRef,
  suppressHeavyShadow = false,
  edgeDecorHandledByOverlay = false,
  onAvatarImageLoad,
}: CircularWebcamProps) {
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgAltRef = useRef<HTMLImageElement | null>(null);
  const showImgARef = useRef(true);
  const [pipWideAspect, setPipWideAspect] = useState(false);

  useEffect(() => {
    const el = videoElRef.current;
    if (el && cameraStream) {
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      el.srcObject = cameraStream;
      const onMeta = () => {
        const vw = el.videoWidth;
        const vh = el.videoHeight;
        if (vw > 0 && vh > 0) {
          const ar = vw / vh;
          setPipWideAspect((prev) => {
            if (ar >= PIP_WIDE_ASPECT_ON) return true;
            if (ar <= PIP_WIDE_ASPECT_OFF) return false;
            return prev;
          });
        } else {
          setPipWideAspect(false);
        }
        setTimeout(() => el.play().catch(() => {}), 50);
      };
      el.onloadedmetadata = onMeta;
      if (el.readyState >= 1) {
        onMeta();
        el.play().catch(() => {});
      }
    } else {
      setPipWideAspect(false);
    }
  }, [cameraStream]);

  // Canvas draw loop when useCanvasForDisplay (fixes WebView video not rendering)
  useEffect(() => {
    if (!useCanvasForDisplay || avatarImageSrc) return;
    // Prefer video that has decoded (readyState>=2); else in-component, else external
    const inComp = videoElRef.current;
    const ext = externalVideoRef?.current;
    const video =
      (ext && ext.readyState >= 2 && ext.videoWidth > 0 ? ext : null) ??
      (inComp && inComp.readyState >= 2 && inComp.videoWidth > 0 ? inComp : null) ??
      (inComp?.srcObject ? inComp : ext ?? inComp);
    const canvas = canvasRef.current;
    if (!video || !canvas || !cameraStream) return;
    let id: number;
    let imgPending = false;
    const draw = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const cw = Math.max(avatarWidth, 64);
          const ch = Math.max(avatarHeight, 64);
          if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
          }
          ctx.clearRect(0, 0, cw, ch);
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const ar = vw / vh;
          const useContain = ar >= PIP_VIDEO_CONTAIN_MIN_ASPECT;
          const s = useContain ? Math.min(cw / vw, ch / vh) : Math.max(cw / vw, ch / vh);
          const sw = vw * s;
          const sh = vh * s;
          const dx = (cw - sw) / 2;
          const dy = (ch - sh) / 2;
          ctx.save();
          if (avatarShape === "circle") {
            const r = Math.min(cw, ch) / 2;
            ctx.beginPath();
            ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.fillStyle = "#000000";
            ctx.beginPath();
            ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.translate(dx + sw, dy);
          ctx.scale(-1, 1);
          ctx.translate(-dx, -dy);
          ctx.drawImage(video, 0, 0, vw, vh, dx, dy, sw, sh);
          ctx.restore();
          if (useImgForDisplay && !imgPending) {
            const imgA = imgRef.current;
            const imgB = imgAltRef.current;
            const target = showImgARef.current ? imgB : imgA;
            if (target) {
              try {
                imgPending = true;
                target.onload = () => {
                  imgPending = false;
                  if (imgA && imgB) {
                    const showA = !showImgARef.current;
                    showImgARef.current = showA;
                    imgA.style.opacity = showA ? "1" : "0";
                    imgB.style.opacity = showA ? "0" : "1";
                  }
                };
                target.src = canvas.toDataURL("image/png");
              } catch {
                imgPending = false;
              }
            }
          }
        }
      }
      id = requestAnimationFrame(draw);
    };
    id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [useCanvasForDisplay, useImgForDisplay, cameraStream, avatarImageSrc, externalVideoRef, avatarShape, avatarWidth, avatarHeight]);

  const shapeClass = avatarShape === "circle" ? "rounded-full" : "rounded-2xl";
  const borderClass =
    avatarDecor === "none"
      ? "border-2 border-black"
      : avatarDecor === "simple"
      ? "border-2 border-white"
      : avatarDecor === "dashed"
        ? "border-[2px] border-white"
        : avatarDecor === "glow"
          ? "border-[2px] border-white/90"
          : "";
  const borderStyle = avatarDecor === "dashed" ? { borderStyle: "dashed" as const } : undefined;

  return (
    <div
      ref={(el) => {
        if (pipRef && "current" in pipRef) {
          (pipRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }
      }}
      className={`absolute cursor-grab touch-none select-none z-[100] ${shapeClass}`}
      style={{
        /* Don't add clipPath when glow: it clips box-shadow. Inner div clips content. */
        ...(avatarShape !== "circle" && avatarDecor !== "glow" && { clipPath: `inset(0 round ${AVATAR_RECT_RADIUS}px)` }),
        transition: "none",
        touchAction: "none",
        left: pipPos.x,
        top: pipPos.y,
        width: avatarWidth,
        height: avatarHeight,
        opacity: hidden || forceCanvasDisplay ? 0.01 : 1,
        pointerEvents: "auto",
        zIndex: 9999,
        ...(avatarDecor === "glow" &&
          !suppressHeavyShadow &&
          !edgeDecorHandledByOverlay && {
            boxShadow: `0 0 48px ${hexToRgba(glowColor, 0.85)}, 0 0 24px ${hexToRgba(glowColor, 0.6)}, inset 0 0 20px rgba(255,255,255,0.15)`,
          }),
      }}
      onMouseDown={onPipMouseDown}
      onPointerDown={(e) => onPipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
    >
      {/* Inner: overflow-hidden clips video to shape; glow stays on outer (no clip) */}
      <div
        className={`absolute inset-0 overflow-hidden ${pipWideAspect ? "bg-black" : ""} ${shapeClass}`}
        style={avatarShape !== "circle" ? { clipPath: `inset(0 round ${AVATAR_RECT_RADIUS}px)` } : undefined}
      >
        {avatarImageSrc ? (
          <img
            ref={avatarImgRef}
            src={avatarImageSrc}
            alt=""
            className="pointer-events-none absolute inset-0 w-full h-full object-cover"
            style={{
              ...(beautyMode ? { filter: beautyFilter } : {}),
              ...(edgeDecorHandledByOverlay ? { opacity: 0 } : {}),
            }}
            draggable={false}
            onLoad={() => onAvatarImageLoad?.()}
          />
        ) : useCanvasForDisplay ? (
          <>
            <video
              ref={(el) => {
                videoElRef.current = el;
                if (cameraVideoRef && el) {
                  if (typeof cameraVideoRef === "function") cameraVideoRef(el);
                  else (cameraVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
                }
                if (el && cameraStream) {
                  el.setAttribute("playsinline", "");
                  el.setAttribute("webkit-playsinline", "");
                  el.srcObject = cameraStream;
                  el.onloadedmetadata = () => {
                    setTimeout(() => el.play().catch(() => {}), 50);
                  };
                  if (el.readyState >= 1) el.play().catch(() => {});
                }
              }}
              autoPlay
              muted
              playsInline
              className="absolute w-[320px] h-[240px] pointer-events-none"
              style={{
                left: 0,
                top: 0,
                opacity: edgeDecorHandledByOverlay ? 0 : 1,
                zIndex: -1,
                transform: "translate3d(0,0,0)",
              }}
              aria-hidden
            />
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 w-full h-full object-cover"
              style={beautyMode ? { filter: beautyFilter } : undefined}
            />
            {useImgForDisplay && (
              <>
                <img
                  ref={imgRef}
                  alt=""
                  className="pointer-events-none absolute inset-0 w-full h-full object-cover"
                  style={{ ...(beautyMode ? { filter: beautyFilter } : {}), opacity: 1 }}
                  draggable={false}
                />
                <img
                  ref={imgAltRef}
                  alt=""
                  className="pointer-events-none absolute inset-0 w-full h-full object-cover"
                  style={{ ...(beautyMode ? { filter: beautyFilter } : {}), opacity: 0 }}
                  draggable={false}
                />
              </>
            )}
          </>
        ) : (
          <video
            ref={(el) => {
              videoElRef.current = el;
              if (cameraVideoRef) {
                if (typeof cameraVideoRef === "function") {
                  cameraVideoRef(el);
                } else {
                  (cameraVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
                }
              }
              if (el && cameraStream) {
                el.srcObject = cameraStream;
                el.play().catch(() => {});
              }
            }}
            autoPlay
            muted
            playsInline
            className={`pointer-events-none absolute inset-0 w-full h-full ${pipWideAspect ? "object-contain" : "object-cover"}`}
            style={{
              transform: "scaleX(-1)",
              ...(beautyMode ? { filter: beautyFilter } : {}),
              ...(edgeDecorHandledByOverlay ? { opacity: 0 } : {}),
            }}
            draggable={false}
          />
        )}
        {/* Border overlay - on top of video, transparent bg, pointer-events-none so drag works */}
        {borderClass && !edgeDecorHandledByOverlay && (
          <div
            className={`absolute inset-0 pointer-events-none z-[1] ${shapeClass} ${borderClass}`}
            style={{
              background: "transparent",
              transition: "none",
              ...(avatarShape !== "circle" && { clipPath: `inset(0 round ${AVATAR_RECT_RADIUS}px)` }),
              ...borderStyle,
            }}
            aria-hidden
          />
        )}
      </div>
      {/* Drag handle - outside inner (not clipped), 40%×40% min 24×24, transparent */}
      <div
        className={`absolute bottom-0 right-0 z-10 cursor-grab active:cursor-grabbing ${avatarShape === "circle" ? "rounded-full" : ""}`}
        style={{ width: "40%", height: "40%", minWidth: 24, minHeight: 24 }}
        onMouseDown={onPipMouseDown}
        onPointerDown={(e) => onPipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
        aria-label="Drag to move camera"
      />
    </div>
  );
}
