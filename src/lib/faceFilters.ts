import {
  FilesetResolver,
  FaceLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";

const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362];
const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const NOSE_TIP = 4;
// Mouth: 61/291 inner lip; 13/14 outer. 478 model may differ. Use chin (152) + nose for mouth center fallback
const CHIN = 152;
let faceLandmarker: FaceLandmarker | null = null;
let lastVideoTs = 0;
let prevSmoothed: NormalizedLandmark[] | null = null;
const SMOOTH_ALPHA = 0.82; // Higher = more responsive (less lag), lower = smoother but laggier

export function nextVideoTimestamp(): number {
  const ts = Math.round(performance.now());
  if (ts <= lastVideoTs) lastVideoTs += 1;
  else lastVideoTs = ts;
  return lastVideoTs;
}

export async function initFaceLandmarker(): Promise<FaceLandmarker> {
  if (faceLandmarker) return faceLandmarker;
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.2,
    minFacePresenceConfidence: 0.2,
    minTrackingConfidence: 0.2,
  });
  return faceLandmarker;
}

function centerOf(landmarks: NormalizedLandmark[], indices: number[]) {
  let x = 0,
    y = 0;
  let n = 0;
  for (const i of indices) {
    const p = landmarks[i];
    if (p != null) {
      x += p.x;
      y += p.y;
      n++;
    }
  }
  return n > 0 ? { x: x / n, y: y / n } : { x: 0.5, y: 0.5 };
}

function smoothLandmarks(raw: NormalizedLandmark[], alpha = SMOOTH_ALPHA): NormalizedLandmark[] {
  if (!prevSmoothed || prevSmoothed.length !== raw.length) {
    prevSmoothed = raw.map((p) => ({ ...p }));
    return prevSmoothed;
  }
  const out: NormalizedLandmark[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const b = prevSmoothed[i];
    if (a && b) {
      out.push({
        x: a.x * alpha + b.x * (1 - alpha),
        y: a.y * alpha + b.y * (1 - alpha),
        z: (a.z ?? 0) * alpha + (b.z ?? 0) * (1 - alpha),
        visibility: (a.visibility ?? 1) * alpha + (b.visibility ?? 1) * (1 - alpha),
      });
    } else {
      out.push(a ? { ...a, visibility: a.visibility ?? 1 } : { x: 0.5, y: 0.5, z: 0, visibility: 1 });
    }
  }
  prevSmoothed = out;
  return out;
}

/** Optional blend alpha (higher = snappier; default SMOOTH_ALPHA). */
export function smoothLandmarksForFilter(
  raw: NormalizedLandmark[] | null,
  responsiveness?: number
): NormalizedLandmark[] | null {
  if (!raw || raw.length < 455) {
    prevSmoothed = null;
    return raw;
  }
  const alpha = responsiveness ?? SMOOTH_ALPHA;
  return smoothLandmarks(raw, alpha);
}

function scaleToRect(
  pt: { x: number; y: number },
  x: number,
  y: number,
  w: number,
  h: number,
  flipX?: boolean
) {
  const px = flipX ? 1 - pt.x : pt.x;
  return {
    x: x + px * w,
    y: y + pt.y * h,
  };
}

export type FaceFilterType = "none" | "sunglasses" | "vampire" | "heart";

export function drawFaceFilter(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[] | null,
  filter: FaceFilterType,
  x: number,
  y: number,
  w: number,
  h: number,
  flipX?: boolean
) {
  if (filter === "none") return;
  if (!landmarks || landmarks.length < 455) return;

  const scale = (pt: { x: number; y: number }) => scaleToRect(pt, x, y, w, h, flipX);
  const safe = (i: number) => landmarks[i] ?? { x: 0.5, y: 0.5 };
  let leftEye = scale(centerOf(landmarks, LEFT_EYE));
  let rightEye = scale(centerOf(landmarks, RIGHT_EYE));
  if (flipX) [leftEye, rightEye] = [rightEye, leftEye];
  const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  const sizeScale = eyeDist * 1.0;
  const cx = (leftEye.x + rightEye.x) / 2;
  const cy = (leftEye.y + rightEye.y) / 2;
  const faceAngle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  ctx.save();
  if (filter !== "heart") {
    ctx.translate(cx, cy);
    ctx.rotate(faceAngle);
    ctx.translate(-cx, -cy);
  }

  if (filter === "sunglasses") {
    const glassW = eyeDist * 1.5;
    const glassH = eyeDist * 0.65;
    const bridgeW = eyeDist * 0.18;
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = Math.max(1.5, sizeScale * 0.05);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.fillStyle = "rgba(0,0,0,0.35)";

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, -1);
    ctx.translate(-cx, -cy);

    ctx.beginPath();
    ctx.ellipse(
      cx - glassW / 2 - bridgeW / 2,
      cy,
      glassW / 2,
      glassH,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(
      cx + glassW / 2 + bridgeW / 2,
      cy,
      glassW / 2,
      glassH,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - bridgeW / 2, cy - glassH * 0.3);
    ctx.lineTo(cx + bridgeW / 2, cy - glassH * 0.3);
    ctx.stroke();

    ctx.restore();
  } else if (filter === "heart") {
    const heartPos = scale({
      x: (safe(NOSE_TIP).x + safe(CHIN).x) / 2,
      y: Math.min(0.92, safe(CHIN).y + 0.26),
    });
    const hx = heartPos.x;
    const hy = heartPos.y;
    const size = sizeScale * 1.4;
    ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🩷", hx, hy);
  } else if (filter === "vampire") {
    const lbPos = scale({ x: safe(CHIN).x - 0.08, y: safe(CHIN).y });
    const size = sizeScale * 0.5;
    ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.translate(lbPos.x, lbPos.y);
    ctx.rotate(Math.PI); // head up
    ctx.fillText("🐞", 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
