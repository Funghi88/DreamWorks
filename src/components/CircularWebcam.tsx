import { useEffect, useRef } from "react";
import type { AvatarShape, AvatarDecor } from "./SettingsPanel";

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
}: CircularWebcamProps) {
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgAltRef = useRef<HTMLImageElement | null>(null);
  const showImgARef = useRef(true);

  useEffect(() => {
    const el = videoElRef.current;
    if (el && cameraStream) {
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      el.srcObject = cameraStream;
      el.onloadedmetadata = () => {
        setTimeout(() => el.play().catch(() => {}), 50);
      };
      if (el.readyState >= 1) el.play().catch(() => {});
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
          const s = Math.max(cw / vw, ch / vh);
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
            ctx.fillStyle = "transparent";
            ctx.beginPath();
            ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2);
            ctx.fill();
          }
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
    avatarDecor === "simple"
      ? "border-4 border-white"
      : avatarDecor === "dashed"
        ? "border border-dashed border-white"
        : avatarDecor === "glow"
          ? "border-[3px] border-white/90"
          : "";
  const shadowClass =
    avatarDecor === "glow"
      ? ""
      : avatarDecor === "none"
        ? "shadow-lg"
        : "shadow-md";

  return (
    <div
      ref={(el) => {
        if (pipRef && "current" in pipRef) {
          (pipRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }
      }}
      className={`absolute overflow-hidden cursor-grab touch-none select-none z-[100] bg-transparent ${shapeClass} ${borderClass} ${shadowClass}`}
      style={{
        touchAction: "none",
        left: pipPos.x,
        top: pipPos.y,
        width: avatarWidth,
        height: avatarHeight,
        opacity: hidden || forceCanvasDisplay ? 0.01 : 1,
        pointerEvents: "auto",
        zIndex: 9999,
        ...(avatarDecor === "glow" && {
          boxShadow: `0 0 24px ${hexToRgba(glowColor, 0.6)}, inset 0 0 12px rgba(255,255,255,0.1)`,
        }),
      }}
      onMouseDown={onPipMouseDown}
      onPointerDown={(e) => onPipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
    >
      {/* Drag handle - circular when avatar is circle, else rectangular */}
      <div
        className={`absolute bottom-0 right-0 z-10 cursor-grab active:cursor-grabbing ${avatarShape === "circle" ? "rounded-full" : ""}`}
        style={{ width: "40%", height: "40%", minWidth: 24, minHeight: 24 }}
        onMouseDown={onPipMouseDown}
        onPointerDown={(e) => onPipMouseDown(e as unknown as React.MouseEvent<HTMLDivElement>)}
        aria-label="Drag to move camera"
      />
      {avatarImageSrc ? (
        <img
          ref={avatarImgRef}
          src={avatarImageSrc}
          alt=""
          className="pointer-events-none absolute inset-0 w-full h-full object-cover"
          style={beautyMode ? { filter: beautyFilter } : undefined}
          draggable={false}
        />
      ) : useCanvasForDisplay ? (
        <>
          {/* Hidden video in same DOM tree as canvas - avoids cross-context issues in WebView */}
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
            style={{ left: 0, top: 0, opacity: 1, zIndex: -1, transform: "translate3d(0,0,0)" }}
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
          className="pointer-events-none absolute inset-0 w-full h-full object-cover"
          style={beautyMode ? { filter: beautyFilter } : undefined}
          draggable={false}
        />
      )}
    </div>
  );
}
