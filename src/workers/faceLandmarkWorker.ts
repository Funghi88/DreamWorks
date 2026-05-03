/// <reference lib="webworker" />

import "./mediapipeWorkerImportShim";
import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  FACE_LANDMARKER_MODEL_URL,
  MEDIAPIPE_VISION_WASM_URL,
} from "@/lib/faceLandmarkerModel";
import { LandmarkSmoother, packLandmarksToFloat32 } from "@/lib/faceLandmarkSmooth";

const smoother = new LandmarkSmoother();
let landmarker: FaceLandmarker | null = null;
let busy = false;

type FromMain =
  | { type: "init" }
  | { type: "frame"; id: number; bitmap: ImageBitmap }
  | { type: "reset-smooth" };

self.onmessage = async (ev: MessageEvent<FromMain>) => {
  const data = ev.data;

  if (data.type === "init") {
    try {
      smoother.reset();
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_VISION_WASM_URL);
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL_URL },
        runningMode: "IMAGE",
        numFaces: 1,
        minFaceDetectionConfidence: 0.2,
        minFacePresenceConfidence: 0.2,
        minTrackingConfidence: 0.2,
      });
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "ready" });
    } catch (e) {
      landmarker = null;
      const message = e instanceof Error ? e.message : String(e);
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "init-error", message });
    }
    return;
  }

  if (data.type === "reset-smooth") {
    smoother.reset();
    return;
  }

  if (data.type !== "frame") return;

  const { id, bitmap } = data;
  if (!landmarker) {
    bitmap.close();
    return;
  }
  if (busy) {
    bitmap.close();
    return;
  }

  busy = true;
  let bmp: ImageBitmap | null = bitmap;
  try {
    const result = landmarker.detect(bitmap);
    bmp.close();
    bmp = null;
    const raw = result.faceLandmarks?.[0];
    if (raw && raw.length >= 455) {
      const smoothed = smoother.smooth(raw, 0.82);
      const packed = packLandmarksToFloat32(smoothed);
      (self as unknown as DedicatedWorkerGlobalScope).postMessage(
        { type: "landmarks", id, count: smoothed.length, buffer: packed.buffer },
        [packed.buffer]
      );
    } else {
      smoother.reset();
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "nohuman", id });
    }
  } catch {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "error", id });
  } finally {
    if (bmp) bmp.close();
    busy = false;
  }
};
