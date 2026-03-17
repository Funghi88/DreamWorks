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
const FOREHEAD = 10;
// Mouth: 61/291 inner lip; 13/14 outer. 478 model may differ. Use chin (152) + nose for mouth center fallback
const CHIN = 152;
let faceLandmarker: FaceLandmarker | null = null;
let lastVideoTs = 0;

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

function scaleToRect(
  pt: { x: number; y: number },
  x: number,
  y: number,
  w: number,
  h: number
) {
  return {
    x: x + pt.x * w,
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
  h: number
) {
  if (filter === "none") return;
  if (!landmarks || landmarks.length < 455) return;

  const safe = (i: number) => landmarks[i] ?? { x: 0.5, y: 0.5 };
  const leftEye = scaleToRect(centerOf(landmarks, LEFT_EYE), x, y, w, h);
  const rightEye = scaleToRect(centerOf(landmarks, RIGHT_EYE), x, y, w, h);
  scaleToRect(
    { x: safe(NOSE_TIP).x, y: safe(NOSE_TIP).y },
    x,
    y,
    w,
    h
  );
  scaleToRect(
    { x: safe(FOREHEAD).x, y: safe(FOREHEAD).y },
    x,
    y,
    w,
    h
  );

  const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  const scale = eyeDist * 1.0;
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
    // Slightly rounder (less oval), keep horizontal
    const glassW = eyeDist * 1.5;
    const glassH = eyeDist * 0.65;
    const bridgeW = eyeDist * 0.18;
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = Math.max(2, scale * 0.06);
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
    const heartPos = scaleToRect(
      { x: (safe(NOSE_TIP).x + safe(CHIN).x) / 2, y: Math.min(0.92, safe(CHIN).y + 0.26) },
      x, y, w, h
    );
    const hx = heartPos.x;
    const hy = heartPos.y;
    const size = scale * 1.4;
    ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🩷", hx, hy);
  } else if (filter === "vampire") {
    // User's right = left in mirrored view → smaller x
    const lbPos = scaleToRect(
      { x: safe(CHIN).x - 0.08, y: safe(CHIN).y },
      x, y, w, h
    );
    const size = scale * 0.5;
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
