import { useEffect, useRef } from "react";
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import {
  inferSegmentationMaskSemantics,
  isSegmentationBackground,
} from "@/lib/mediapipeSegmentationMask";
import type { BackgroundMode } from "./useVirtualBackground";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const SEGMENTER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite";

interface VirtualBackgroundProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  mode: BackgroundMode;
  color?: string;
  imageUrl?: string | null;
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
  imageUrl,
  onFrame,
}: VirtualBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const segmenterRef = useRef<ImageSegmenter | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if ((mode !== "color" && mode !== "blur" && mode !== "image") || !enabled) return;
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
          const blurSemantics = inferSegmentationMaskSemantics(
            maskData,
            maskW,
            maskH,
            w,
            h,
            scaleX,
            scaleY
          );

          const offscreen = document.createElement("canvas");
          offscreen.width = w;
          offscreen.height = h;
          const octx = offscreen.getContext("2d")!;
          octx.drawImage(video, 0, 0);
          const sharpData = octx.getImageData(0, 0, w, h);
          const blurRadius = Math.max(32, Math.min(w, h) * 0.1);
          octx.filter = `blur(${blurRadius}px)`;
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
              let bgConf = maskData[idx] ?? 0;
              bgConf = Math.max(0, Math.min(1, (bgConf - 0.25) / 0.5));
              if (blurSemantics === "person") {
                bgConf = 1 - bgConf;
              }
              const i = (y * w + x) * 4;
              sd[i] = (1 - bgConf) * sd[i] + bgConf * bd[i];
              sd[i + 1] = (1 - bgConf) * sd[i + 1] + bgConf * bd[i + 1];
              sd[i + 2] = (1 - bgConf) * sd[i + 2] + bgConf * bd[i + 2];
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
        const bgMask = masks[0];
        const maskData = bgMask.getAsFloat32Array();
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);

        const maskW = bgMask.width;
        const maskH = bgMask.height;
        const scaleX = maskW / w;
        const scaleY = maskH / h;
        const threshold = 0.5;
        const colorSemantics = inferSegmentationMaskSemantics(
          maskData,
          maskW,
          maskH,
          w,
          h,
          scaleX,
          scaleY
        );

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const mx = Math.min(Math.floor(x * scaleX), maskW - 1);
            const my = Math.min(Math.floor(y * scaleY), maskH - 1);
            const bgConf = maskData[my * maskW + mx] ?? 0;
            const i = (y * w + x) * 4;
            if (isSegmentationBackground(bgConf, colorSemantics, threshold)) {
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

    if (mode === "image" && imageUrl) {
      bgImageRef.current = null;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = imageUrl;
      img.onload = () => { bgImageRef.current = img; };
    }

    const drawImage = () => {
      const seg = segmenterRef.current;
      const bgImg = bgImageRef.current;
      if (video.readyState < 2 || !bgImg) {
        rafRef.current = requestAnimationFrame(drawImage);
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
        rafRef.current = requestAnimationFrame(drawImage);
        return;
      }

      ctx.drawImage(video, 0, 0);
      const timestamp = video.currentTime * 1000;
      seg.segmentForVideo(video, timestamp, (result) => {
        const masks = result.confidenceMasks;
        if (!masks || masks.length === 0) {
          rafRef.current = requestAnimationFrame(drawImage);
          return;
        }
        const bgMask = masks[0];
        const maskData = bgMask.getAsFloat32Array();
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        const maskW = bgMask.width;
        const maskH = bgMask.height;
        const scaleX = maskW / w;
        const scaleY = maskH / h;
        const threshold = 0.5;
        const imageSemantics = inferSegmentationMaskSemantics(
          maskData,
          maskW,
          maskH,
          w,
          h,
          scaleX,
          scaleY
        );

        const iw = bgImg.naturalWidth;
        const ih = bgImg.naturalHeight;
        const scale = Math.max(w / iw, h / ih);
        const sW = w / scale;
        const sH = h / scale;
        const sx = (iw - sW) / 2;
        const sy = (ih - sH) / 2;

        const imgCanvas = document.createElement("canvas");
        imgCanvas.width = w;
        imgCanvas.height = h;
        const ictx = imgCanvas.getContext("2d")!;
        ictx.drawImage(bgImg, sx, sy, sW, sH, 0, 0, w, h);
        const bgData = ictx.getImageData(0, 0, w, h).data;

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const mx = Math.min(Math.floor(x * scaleX), maskW - 1);
            const my = Math.min(Math.floor(y * scaleY), maskH - 1);
            const bgConf = maskData[my * maskW + mx] ?? 0;
            const i = (y * w + x) * 4;
            if (isSegmentationBackground(bgConf, imageSemantics, threshold)) {
              data[i] = bgData[i];
              data[i + 1] = bgData[i + 1];
              data[i + 2] = bgData[i + 2];
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);
      });
      rafRef.current = requestAnimationFrame(drawImage);
    };

    if (mode === "blur") {
      drawBlur();
    } else if (mode === "color") {
      drawColor();
    } else if (mode === "image" && imageUrl) {
      drawImage();
    }

    return () => cancelAnimationFrame(rafRef.current);
  }, [videoRef, enabled, mode, color, imageUrl, onFrame]);

  if (!enabled || mode === "none") return null;
  if (mode === "image" && !imageUrl) return null;
  return (
    <canvas
      ref={canvasRef}
      className="virtual-background-canvas"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: 1 }}
    />
  );
}
