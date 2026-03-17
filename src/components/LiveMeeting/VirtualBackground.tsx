import { useEffect, useRef } from "react";
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import type { BackgroundMode } from "./useVirtualBackground";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const SEGMENTER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite";

interface VirtualBackgroundProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  mode: BackgroundMode;
  color?: string;
  onFrame?: (ctx: CanvasRenderingContext2D, video: HTMLVideoElement) => void;
}

let segmenterPromise: Promise<ImageSegmenter | null> | null = null;

async function getSegmenter(): Promise<ImageSegmenter | null> {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      return await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: SEGMENTER_MODEL },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
      });
    } catch {
      return null;
    }
  })();
  return segmenterPromise;
}

export function preloadSegmenter(): void {
  getSegmenter();
}

export function VirtualBackground({
  videoRef,
  enabled,
  mode,
  color = "#1e293b",
  onFrame,
}: VirtualBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const segmenterRef = useRef<ImageSegmenter | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if ((mode !== "color" && mode !== "blur") || !enabled) return;
    getSegmenter().then((seg) => {
      segmenterRef.current = seg;
    });
  }, [mode, enabled]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !enabled || mode === "none") return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const drawBlur = () => {
      const seg = segmenterRef.current;
      if (video.readyState < 2) {
        rafRef.current = requestAnimationFrame(drawBlur);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w <= 0 || h <= 0) {
        rafRef.current = requestAnimationFrame(drawBlur);
        return;
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      if (!seg) {
        ctx.drawImage(video, 0, 0);
        rafRef.current = requestAnimationFrame(drawBlur);
        return;
      }

      const timestamp = video.currentTime * 1000;
      seg.segmentForVideo(video, timestamp, (result) => {
        const masks = result.confidenceMasks;
        if (!masks || masks.length === 0) {
          ctx.drawImage(video, 0, 0);
        } else {
          const bgMask = masks[0];
          const maskData = bgMask.getAsFloat32Array();
          const maskW = bgMask.width;
          const maskH = bgMask.height;
          const scaleX = maskW / w;
          const scaleY = maskH / h;

          const offscreen = document.createElement("canvas");
          offscreen.width = w;
          offscreen.height = h;
          const octx = offscreen.getContext("2d")!;
          octx.drawImage(video, 0, 0);
          const sharpData = octx.getImageData(0, 0, w, h);
          octx.filter = "blur(40px)";
          octx.drawImage(video, 0, 0);
          octx.filter = "none";
          const blurredData = octx.getImageData(0, 0, w, h);
          const bd = blurredData.data;
          const sd = sharpData.data;

          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const mx = Math.min(Math.floor(x * scaleX), maskW - 1);
              const my = Math.min(Math.floor(y * scaleY), maskH - 1);
              const idx = Math.min(my * maskW + mx, maskData.length - 1);
              const bgConf = maskData[idx] ?? 0;
              const i = (y * w + x) * 4;
              if (bgConf > 0.5) {
                sd[i] = bd[i];
                sd[i + 1] = bd[i + 1];
                sd[i + 2] = bd[i + 2];
              }
            }
          }
          ctx.putImageData(sharpData, 0, 0);
        }
        rafRef.current = requestAnimationFrame(drawBlur);
      });
    };

    const drawColor = () => {
      const seg = segmenterRef.current;
      if (video.readyState < 2) {
        rafRef.current = requestAnimationFrame(drawColor);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      if (!seg) {
        ctx.drawImage(video, 0, 0);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
        rafRef.current = requestAnimationFrame(drawColor);
        return;
      }

      ctx.drawImage(video, 0, 0);
      const timestamp = video.currentTime * 1000;
      seg.segmentForVideo(video, timestamp, (result) => {
        const masks = result.confidenceMasks;
        if (!masks || masks.length === 0) {
          rafRef.current = requestAnimationFrame(drawColor);
          return;
        }
        const personMask = masks[1] ?? masks[0];
        const maskData = personMask.getAsFloat32Array();
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);

        const maskW = personMask.width;
        const maskH = personMask.height;
        const scaleX = maskW / w;
        const scaleY = maskH / h;

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const mx = Math.min(Math.floor(x * scaleX), maskW - 1);
            const my = Math.min(Math.floor(y * scaleY), maskH - 1);
            const m = maskData[my * maskW + mx] ?? 0;
            const i = (y * w + x) * 4;
            if (m < 0.5) {
              data[i] = r;
              data[i + 1] = g;
              data[i + 2] = b;
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);
      });
      rafRef.current = requestAnimationFrame(drawColor);
    };

    if (mode === "blur") {
      drawBlur();
    } else if (mode === "color") {
      drawColor();
    }

    return () => cancelAnimationFrame(rafRef.current);
  }, [videoRef, enabled, mode, color, onFrame]);

  if (!enabled || mode === "none") return null;
  return (
    <canvas
      ref={canvasRef}
      className="virtual-background-canvas"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: 1 }}
    />
  );
}
