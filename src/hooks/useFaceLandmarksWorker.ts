import { useEffect, useRef } from "react";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  FACE_LANDMARKER_MODEL_URL,
  MEDIAPIPE_VISION_WASM_URL,
} from "@/lib/faceLandmarkerModel";
import { LandmarkSmoother, unpackLandmarksFromFloat32 } from "@/lib/faceLandmarkSmooth";

const INTERVAL_RECORDING_MS = 1000 / 14;
const INTERVAL_IDLE_MS = 1000 / 22;
const WORKER_INIT_TIMEOUT_MS = 15_000;

/**
 * Electron: `createImageBitmap(video)` may reject or yield empty pixels for off-DOM / opacity-0 sources.
 * Copy one frame through a 2D canvas when direct sampling fails.
 */
async function videoFrameToBitmap(v: HTMLVideoElement): Promise<ImageBitmap | null> {
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (!v.srcObject || w <= 0 || h <= 0) return null;
  try {
    const b = await createImageBitmap(v);
    if (b.width > 0 && b.height > 0) return b;
    b.close();
  } catch {
    /* canvas fallback */
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(v, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  }
}

type WorkerToMain =
  | { type: "ready" }
  | { type: "init-error"; message: string }
  | { type: "landmarks"; id: number; count: number; buffer: ArrayBuffer }
  | { type: "nohuman"; id: number }
  | { type: "error"; id: number };

export function useFaceLandmarksWorker(options: {
  enabled: boolean;
  getVideo: () => HTMLVideoElement | null;
  isRecordingRef: React.RefObject<boolean>;
  pipDraggingRef: React.RefObject<boolean>;
  previewBoxDraggingRef: React.RefObject<boolean>;
  faceLandmarksRef: React.MutableRefObject<NormalizedLandmark[] | null>;
  lastValidLandmarksRef: React.MutableRefObject<NormalizedLandmark[] | null>;
  lastValidLandmarksAtRef: React.MutableRefObject<number>;
}): void {
  const {
    enabled,
    getVideo,
    isRecordingRef,
    pipDraggingRef,
    previewBoxDraggingRef,
    faceLandmarksRef,
    lastValidLandmarksRef,
    lastValidLandmarksAtRef,
  } = options;

  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const landmarkerMainRef = useRef<FaceLandmarker | null>(null);
  const mainReadyRef = useRef(false);
  const mainBusyRef = useRef(false);
  const mainSmootherRef = useRef<LandmarkSmoother | null>(null);
  const frameIdRef = useRef(0);
  const lastAppliedIdRef = useRef(0);
  const lastCaptureAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      workerRef.current?.terminate();
      workerRef.current = null;
      workerReadyRef.current = false;
      landmarkerMainRef.current?.close();
      landmarkerMainRef.current = null;
      mainReadyRef.current = false;
      mainBusyRef.current = false;
      mainSmootherRef.current?.reset();
      mainSmootherRef.current = null;
      return;
    }

    const worker = new Worker(new URL("../workers/faceLandmarkWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    workerReadyRef.current = false;
    mainReadyRef.current = false;
    worker.postMessage({ type: "init" });

    let cancelled = false;

    const tearDownWorker = () => {
      worker.removeEventListener("message", onMsg);
      worker.terminate();
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
      workerReadyRef.current = false;
    };

    const startMainFallback = (reason: string) => {
      if (cancelled || mainReadyRef.current || landmarkerMainRef.current) return;
      console.warn("[faceLandmarks] main-thread fallback:", reason);
      tearDownWorker();
      if (!mainSmootherRef.current) {
        mainSmootherRef.current = new LandmarkSmoother();
      }
      mainSmootherRef.current.reset();
      void (async () => {
        try {
          const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_VISION_WASM_URL);
          const lm = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL_URL },
            runningMode: "IMAGE",
            numFaces: 1,
            minFaceDetectionConfidence: 0.2,
            minFacePresenceConfidence: 0.2,
            minTrackingConfidence: 0.2,
          });
          if (cancelled) {
            lm.close();
            return;
          }
          landmarkerMainRef.current = lm;
          mainReadyRef.current = true;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.warn("[faceLandmarks] main-thread init failed:", message);
          mainReadyRef.current = false;
        }
      })();
    };

    const initTimeoutId = window.setTimeout(() => {
      if (cancelled || workerReadyRef.current || mainReadyRef.current) return;
      startMainFallback("worker init timeout");
    }, WORKER_INIT_TIMEOUT_MS);

    const onMsg = (ev: MessageEvent<WorkerToMain>) => {
      const msg = ev.data;
      if (msg.type === "ready") {
        workerReadyRef.current = true;
        window.clearTimeout(initTimeoutId);
        return;
      }
      if (msg.type === "init-error") {
        workerReadyRef.current = false;
        console.warn("[faceLandmarkWorker]", msg.message);
        window.clearTimeout(initTimeoutId);
        startMainFallback(msg.message);
        return;
      }
      if (msg.type === "landmarks") {
        if (msg.id < lastAppliedIdRef.current) return;
        lastAppliedIdRef.current = msg.id;
        const arr = new Float32Array(msg.buffer);
        const lm = unpackLandmarksFromFloat32(arr, msg.count);
        faceLandmarksRef.current = lm;
        lastValidLandmarksRef.current = lm;
        lastValidLandmarksAtRef.current = performance.now();
        return;
      }
      if (msg.type === "nohuman") {
        if (msg.id < lastAppliedIdRef.current) return;
        lastAppliedIdRef.current = msg.id;
        faceLandmarksRef.current = null;
        return;
      }
      if (msg.type === "error") {
        if (msg.id < lastAppliedIdRef.current) return;
      }
    };
    worker.addEventListener("message", onMsg);

    let rafId = 0;

    const loop = () => {
      if (cancelled) return;
      rafId = requestAnimationFrame(loop);

      const gesturing = pipDraggingRef.current || previewBoxDraggingRef.current;
      if (gesturing) {
        return;
      }

      if (!workerReadyRef.current && !mainReadyRef.current) return;

      const v = getVideo();
      // Keep in sync with App `cameraVideoReadableForPipEffects` (PiP + face filters).
      if (!v?.srcObject || v.videoWidth <= 0 || v.readyState < 1) return;

      const interval = isRecordingRef.current ? INTERVAL_RECORDING_MS : INTERVAL_IDLE_MS;
      const now = performance.now();
      if (now - lastCaptureAtRef.current < interval) return;
      lastCaptureAtRef.current = now;

      const id = ++frameIdRef.current;

      if (workerReadyRef.current && workerRef.current) {
        void videoFrameToBitmap(v).then((bitmap) => {
          if (cancelled || !workerRef.current) {
            bitmap?.close();
            return;
          }
          if (!bitmap) return;
          try {
            workerRef.current.postMessage({ type: "frame", id, bitmap }, [bitmap]);
          } catch {
            bitmap.close();
          }
        });
        return;
      }

      const lmMain = landmarkerMainRef.current;
      const smoother = mainSmootherRef.current;
      if (!lmMain || !smoother || mainBusyRef.current) return;

      mainBusyRef.current = true;
      void videoFrameToBitmap(v).then((bitmap) => {
        if (cancelled || !landmarkerMainRef.current) {
          bitmap?.close();
          mainBusyRef.current = false;
          return;
        }
        if (!bitmap) {
          mainBusyRef.current = false;
          return;
        }
        try {
          const result = landmarkerMainRef.current.detect(bitmap);
          const raw = result.faceLandmarks?.[0];
          if (raw && raw.length >= 455) {
            const smoothed = smoother.smooth(raw, 0.82);
            if (id < lastAppliedIdRef.current) return;
            lastAppliedIdRef.current = id;
            faceLandmarksRef.current = smoothed;
            lastValidLandmarksRef.current = smoothed;
            lastValidLandmarksAtRef.current = performance.now();
          } else {
            smoother.reset();
            if (id < lastAppliedIdRef.current) return;
            lastAppliedIdRef.current = id;
            faceLandmarksRef.current = null;
          }
        } catch {
          if (id >= lastAppliedIdRef.current) {
            lastAppliedIdRef.current = id;
          }
        } finally {
          bitmap.close();
          mainBusyRef.current = false;
        }
      });
    };

    rafId = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      window.clearTimeout(initTimeoutId);
      cancelAnimationFrame(rafId);
      worker.removeEventListener("message", onMsg);
      worker.terminate();
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
      workerReadyRef.current = false;
      landmarkerMainRef.current?.close();
      landmarkerMainRef.current = null;
      mainReadyRef.current = false;
      mainBusyRef.current = false;
      mainSmootherRef.current?.reset();
      mainSmootherRef.current = null;
    };
  }, [
    enabled,
    getVideo,
    isRecordingRef,
    pipDraggingRef,
    previewBoxDraggingRef,
    faceLandmarksRef,
    lastValidLandmarksRef,
    lastValidLandmarksAtRef,
  ]);
}
