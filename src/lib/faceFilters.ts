import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export type FaceFilterType =
  | "none"
  | "sunglasses"
  | "firefly"
  | "heart"
  | "moustache"
  | "brows"
  | "rolleyes";

/** Legacy persisted value */
export type LegacyFaceFilterType = FaceFilterType | "vampire";

export function normalizeFaceFilterFromStorage(v: string | undefined): FaceFilterType {
  if (!v || v === "none") return "none";
  if (v === "vampire") return "firefly";
  if (
    v === "sunglasses" ||
    v === "firefly" ||
    v === "heart" ||
    v === "moustache" ||
    v === "brows" ||
    v === "rolleyes"
  ) {
    return v;
  }
  return "none";
}

/** MediaPipe Face Landmarker mesh — left eye contour (lower lid + corners; stable centroid for face pose). */
const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362];
/** MediaPipe Face Landmarker mesh — right eye contour */
const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133];
/**
 * Full FACEMESH_*_EYE loop including upper eyelid — bbox height tracks blink / wide open.
 * (Short LEFT_EYE/RIGHT_EYE omit the upper arc, so rolling-eye ovals barely changed vertically.)
 */
const LEFT_EYE_FULL = [
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
];
const RIGHT_EYE_FULL = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];
/** Left cheek / zygomatic region (468 topology) */
const LEFT_CHEEK = [123, 50, 205, 187, 207, 216];
/** Right cheek / zygomatic region */
const RIGHT_CHEEK = [352, 280, 425, 411, 436, 422];
/** Left / right eyebrow upper arc (468) — inner (nose) → outer */
const LEFT_BROW = [70, 63, 105, 66, 107];
const RIGHT_BROW = [336, 296, 334, 293, 300];
/**
 * MediaPipe 468 outer lip loop (one winding around the mouth opening).
 * Used for furry “around the mouth” facial hair.
 */
const MOUTH_OUTER_RING = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146,
];

function polyScaled(
  landmarks: NormalizedLandmark[],
  indices: number[],
  scale: (pt: { x: number; y: number }) => { x: number; y: number }
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const i of indices) {
    const p = landmarks[i];
    if (p != null) out.push(scale({ x: p.x, y: p.y }));
  }
  return out;
}

function bboxOf(pts: { x: number; y: number }[]) {
  if (pts.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  let minX = pts[0].x,
    maxX = pts[0].x,
    minY = pts[0].y,
    maxY = pts[0].y;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
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
  h: number,
  flipX?: boolean
) {
  const px = flipX ? 1 - pt.x : pt.x;
  return {
    x: x + px * w,
    y: y + pt.y * h,
  };
}

/** World screen point → coordinates to use after translate(cx,cy) rotate(angle) translate(-cx,-cy). */
function preRotateAround(
  cx: number,
  cy: number,
  angle: number,
  wx: number,
  wy: number
): { x: number; y: number } {
  const dx = wx - cx;
  const dy = wy - cy;
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  return {
    x: cx + dx * c - dy * s,
    y: cy + dx * s + dy * c,
  };
}

/**
 * Same as preRotateAround, then mirror Y around `cy` in the rotated (face-aligned) user space.
 * Fixes hat/ears/motes drawn upside-down without flipping landmark→screen Y (which would invert head tracking).
 */
function preRotateAroundFlipArtY(
  cx: number,
  cy: number,
  angle: number,
  wx: number,
  wy: number
): { x: number; y: number } {
  const u = preRotateAround(cx, cy, angle, wx, wy);
  return { x: u.x, y: 2 * cy - u.y };
}

/** Heart tip toward chin (canvas +Y); lobes toward forehead (−Y). */
function drawHeartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number) {
  const s = scale * 0.55;
  const fy = (y: number) => 2 * cy - y;
  ctx.beginPath();
  ctx.moveTo(cx, fy(cy + s * 0.35));
  ctx.bezierCurveTo(cx, fy(cy), cx - s * 0.9, fy(cy - s * 0.5), cx - s * 0.9, fy(cy));
  ctx.bezierCurveTo(cx - s * 0.9, fy(cy + s * 0.35), cx, fy(cy + s * 0.85), cx, fy(cy + s * 1.15));
  ctx.bezierCurveTo(cx, fy(cy + s * 0.85), cx + s * 0.9, fy(cy + s * 0.35), cx + s * 0.9, fy(cy));
  ctx.bezierCurveTo(cx + s * 0.9, fy(cy - s * 0.5), cx, fy(cy), cx, fy(cy + s * 0.35));
  ctx.closePath();
}

function drawCheekMotes(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  faceAngle: number,
  cheekL: { x: number; y: number },
  cheekR: { x: number; y: number },
  sizeScale: number,
  nowMs: number
) {
  const t = nowMs / 1000;
  const bases = [
    preRotateAroundFlipArtY(cx, cy, faceAngle, cheekL.x, cheekL.y),
    preRotateAroundFlipArtY(cx, cy, faceAngle, cheekL.x, cheekL.y),
    preRotateAroundFlipArtY(cx, cy, faceAngle, cheekL.x, cheekL.y),
    preRotateAroundFlipArtY(cx, cy, faceAngle, cheekR.x, cheekR.y),
    preRotateAroundFlipArtY(cx, cy, faceAngle, cheekR.x, cheekR.y),
    preRotateAroundFlipArtY(cx, cy, faceAngle, cheekR.x, cheekR.y),
    preRotateAroundFlipArtY(cx, cy, faceAngle, (cheekL.x + cheekR.x) / 2, (cheekL.y + cheekR.y) / 2),
    preRotateAroundFlipArtY(cx, cy, faceAngle, (cheekL.x + cheekR.x) / 2, (cheekL.y + cheekR.y) / 2),
  ];
  const phases = [0, 1.7, 3.1, 0.9, 2.4, 4.2, 1.2, 3.8];

  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    const phase = phases[i];
    const wobble =
      Math.sin(t * 2.4 + phase) * sizeScale * 0.1 + Math.sin(t * 4.1 + phase * 2) * sizeScale * 0.04;
    const wobbleY =
      Math.cos(t * 2.0 + phase * 1.1) * sizeScale * 0.09 +
      Math.cos(t * 3.3 + phase) * sizeScale * 0.035;
    const ox = base.x + wobble;
    const oy = base.y + wobbleY;
    const flicker = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * 6.5 + phase));
    const r = sizeScale * (0.065 + 0.025 * Math.sin(t * 3.8 + i));

    const tailLen = sizeScale * 0.2;
    const tailAngle = t * 1.8 + phase + i * 0.7;
    const tx = ox - Math.cos(tailAngle) * tailLen;
    const ty = oy - Math.sin(tailAngle) * tailLen;
    const grad = ctx.createLinearGradient(tx, ty, ox, oy);
    grad.addColorStop(0, "rgba(160, 240, 255, 0)");
    grad.addColorStop(1, `rgba(200, 255, 230, ${0.4 * flicker})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1, sizeScale * 0.035);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(ox, oy);
    ctx.stroke();

    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, r * 2.4);
    g.addColorStop(0, `rgba(255, 255, 245, ${0.92 * flicker})`);
    g.addColorStop(0.4, `rgba(180, 255, 220, ${0.45 * flicker})`);
    g.addColorStop(1, "rgba(120, 200, 255, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ox, oy, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTwinHearts(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  faceAngle: number,
  cheekL: { x: number; y: number },
  cheekR: { x: number; y: number },
  sizeScale: number,
  nowMs: number
) {
  const pulse = 0.88 + 0.12 * Math.sin(nowMs / 320);
  const half = sizeScale * 0.22 * pulse;
  const offset = sizeScale * 0.08;

  for (const cheek of [cheekL, cheekR]) {
    const outward = cheek.x < cx ? -1 : 1;
    const p = preRotateAround(cx, cy, faceAngle, cheek.x + outward * offset, cheek.y - sizeScale * 0.06);
    drawHeartPath(ctx, p.x, p.y, half);
    const fillGrad = ctx.createRadialGradient(
      p.x,
      p.y - half * 0.2,
      0,
      p.x,
      p.y,
      half * 1.2
    );
    fillGrad.addColorStop(0, "rgba(255, 170, 200, 0.96)");
    fillGrad.addColorStop(0.45, "rgba(255, 95, 140, 0.9)");
    fillGrad.addColorStop(1, "rgba(210, 50, 100, 0.78)");
    ctx.fillStyle = fillGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(130, 25, 70, 0.55)";
    ctx.lineWidth = Math.max(1, half * 0.12);
    ctx.stroke();
  }
}

type FurryStrokeOpts = {
  hairLenMul?: number;
  steps?: number;
  lineWidthMul?: number;
  /** >1 → more scatter, airier gaps between hairs */
  jitterMul?: number;
};

/** Short strokes along a polyline with slight outward offset (hair texture). */
function strokeFurryPolyline(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  outwardSign: number,
  sizeScale: number,
  hue: { dark: string; mid: string },
  opts?: FurryStrokeOpts
) {
  if (pts.length < 2) return;
  const hairLenMul = opts?.hairLenMul ?? 1;
  const steps = opts?.steps ?? 5;
  const lineWidthMul = opts?.lineWidthMul ?? 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * outwardSign;
    const ny = (dx / len) * outwardSign;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const bx = a.x + dx * t;
      const by = a.y + dy * t;
      const jitter =
        (Math.sin(i * 7 + s * 2.1) * 0.5 + 0.5) * sizeScale * 0.04 * (opts?.jitterMul ?? 1);
      const hairLen = sizeScale * (0.09 + (s % 3) * 0.02) * hairLenMul;
      ctx.strokeStyle = s % 2 === 0 ? hue.dark : hue.mid;
      ctx.lineWidth = Math.max(0.6, sizeScale * 0.022 * lineWidthMul);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(bx + nx * jitter, by + ny * jitter);
      ctx.lineTo(bx + nx * (jitter + hairLen), by + ny * (jitter + hairLen));
      ctx.stroke();
    }
  }
}

/**
 * Geometry in a working frame: flat bar + sides + lower semicircle, then flipped across
 * mouth mid-height so the flat band sits above the upper lip and the U hugs the lower lip
 * (face-local Y from lip bbox can read inverted vs on-screen up/down after rotation).
 */
function mouthBeardHybridOutline(
  lipLocal: { x: number; y: number }[],
  padX: number,
  padY: number,
  cornerFrac: number
): { x: number; y: number }[] {
  const b = bboxOf(lipLocal);
  const cxM = (b.minX + b.maxX) / 2;
  const cyM = (b.minY + b.maxY) / 2;
  let hw = ((b.maxX - b.minX) / 2) * padX;
  let hh = ((b.maxY - b.minY) / 2) * padY;
  if (hw < 3) hw = 3;
  if (hh < 3) hh = 3;
  const x0 = cxM - hw;
  const x1 = cxM + hw;
  const y0 = cyM - hh;
  let r = Math.min(hw, hh) * cornerFrac;
  r = Math.min(r, hw * 0.48, hh * 0.48);
  const R = hw;
  const yLine = Math.min(cyM + hh * 0.52, cyM + hh - r * 0.35);
  if (yLine <= y0 + r + 2) return [];
  const se = 6;
  const sc = 5;
  const nArc = 14;
  const raw: { x: number; y: number }[] = [];

  for (let i = 0; i <= se; i++) {
    const t = i / se;
    raw.push({ x: x0 + r + t * (x1 - x0 - 2 * r), y: y0 });
  }
  for (let i = 1; i <= sc; i++) {
    const u = (i / sc) * (Math.PI / 2);
    raw.push({ x: x1 - r + r * Math.sin(u), y: y0 + r - r * Math.cos(u) });
  }
  for (let i = 1; i <= se; i++) {
    const t = i / se;
    raw.push({ x: x1, y: y0 + r + t * (yLine - (y0 + r)) });
  }
  for (let i = 0; i <= nArc; i++) {
    const t = i / nArc;
    const ang = t * Math.PI;
    raw.push({ x: cxM + R * Math.cos(ang), y: yLine + R * Math.sin(ang) });
  }
  for (let i = 1; i <= se; i++) {
    const t = i / se;
    raw.push({ x: x0, y: yLine - t * (yLine - (y0 + r)) });
  }
  for (let i = 1; i <= sc; i++) {
    const u = (Math.PI / 2) * (1 - i / sc);
    raw.push({ x: x0 + r - r * Math.sin(u), y: y0 + r - r * Math.cos(u) });
  }

  return raw.map((p) => ({ x: p.x, y: 2 * cyM - p.y }));
}

/** Pick ±1 so fur grows away from ring centroid (out of the mouth). */
function outwardSignForMouthRing(pts: { x: number; y: number }[]): 1 | -1 {
  if (pts.length < 3) return 1;
  let cx = 0,
    cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  const a = pts[0];
  const b = pts[1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const lx = -dy / len;
  const ly = dx / len;
  const mx = (a.x + b.x) / 2 - cx;
  const my = (a.y + b.y) / 2 - cy;
  return lx * mx + ly * my >= 0 ? 1 : -1;
}

function drawFurryBrows(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  faceAngle: number,
  leftPts: { x: number; y: number }[],
  rightPts: { x: number; y: number }[],
  sizeScale: number
) {
  const toLocal = (p: { x: number; y: number }) => preRotateAround(cx, cy, faceAngle, p.x, p.y);
  const leftT = leftPts.map(toLocal);
  const rightT = rightPts.map(toLocal);
  /** +1 = hair grows toward forehead (away from cheek) in face-aligned space */
  const brown = { dark: "rgba(35,22,14,0.92)", mid: "rgba(55,38,26,0.85)" };
  strokeFurryPolyline(ctx, leftT, 1, sizeScale, brown);
  strokeFurryPolyline(ctx, rightT, 1, sizeScale, brown);
  strokeFurryPolyline(ctx, leftT, 1, sizeScale, { dark: "rgba(25,16,10,0.75)", mid: "rgba(45,30,20,0.7)" });
  strokeFurryPolyline(ctx, rightT, 1, sizeScale, { dark: "rgba(25,16,10,0.75)", mid: "rgba(45,30,20,0.7)" });
}

/**
 * Furry mouth ring: rounded top + semicircular bottom; warm brown, airy strokes.
 */
function drawFurryMouthBeard(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  faceAngle: number,
  ring: { x: number; y: number }[],
  sizeScale: number
) {
  if (ring.length < 4) return;
  const toLocal = (p: { x: number; y: number }) => preRotateAround(cx, cy, faceAngle, p.x, p.y);
  const lipLocal = ring.map(toLocal);
  const outline = mouthBeardHybridOutline(lipLocal, 1.2, 1.18, 0.38);
  if (outline.length < 8) return;
  const sign = outwardSignForMouthRing(outline);
  const closed = [...outline, outline[0]];
  /** Single warm brown for every stroke (dark === mid so top/bottom arcs match). */
  const brown = "rgba(124, 78, 46, 0.4)";
  const hair = { dark: brown, mid: brown };
  const base: FurryStrokeOpts = {
    hairLenMul: 1.58,
    steps: 4,
    lineWidthMul: 0.72,
    jitterMul: 2.05,
  };
  strokeFurryPolyline(ctx, closed, sign, sizeScale, hair, base);
  strokeFurryPolyline(ctx, closed, sign, sizeScale, hair, {
    ...base,
    hairLenMul: 1.35,
    lineWidthMul: 0.64,
    jitterMul: 2.25,
  });
  strokeFurryPolyline(ctx, closed, sign, sizeScale, hair, {
    hairLenMul: 1.1,
    steps: 3,
    lineWidthMul: 0.58,
    jitterMul: 1.85,
  });
}

function drawRollingEyesOverlay(
  ctx: CanvasRenderingContext2D,
  leftPoly: { x: number; y: number }[],
  rightPoly: { x: number; y: number }[]
) {
  for (const poly of [leftPoly, rightPoly]) {
    if (poly.length < 4) continue;
    const b = bboxOf(poly);
    const ecx = (b.minX + b.maxX) / 2;
    const ecy = (b.minY + b.maxY) / 2;
    const eyeW = b.maxX - b.minX;
    const eyeH = b.maxY - b.minY;
    /** Height/width of palpebral opening — drops when squinting, rises when eyes widen. */
    const openness = eyeH / Math.max(eyeW, 1e-6);
    const mul = Math.min(1.26, Math.max(0.5, 0.52 + openness * 1.38));
    const rx = eyeW * 0.72 * mul * 0.96;
    /** Taller sclera; mul reinforces blink so narrow vs wide open reads clearly. */
    const ry = eyeH * 0.74 * mul;

    ctx.beginPath();
    ctx.ellipse(ecx, ecy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#f4f0e8";
    ctx.fill();
    ctx.strokeStyle = "rgba(45, 38, 32, 0.28)";
    ctx.lineWidth = Math.max(1, rx * 0.04);
    ctx.stroke();

    const irisRy = Math.min(rx, ry) * 0.42;
    const irisRx = irisRy * 0.95;
    const rollUp = ry * 0.34;
    ctx.beginPath();
    ctx.ellipse(ecx, ecy - rollUp, irisRx, irisRy, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#8b9dc9";
    ctx.fill();
    ctx.strokeStyle = "rgba(30, 40, 55, 0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ecx, ecy - rollUp * 1.08, irisRy * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = "#0d0d0d";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ecx - irisRx * 0.25, ecy - rollUp * 1.12, irisRy * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(ecx, ecy + ry * 0.28, rx * 0.92, ry * 0.22, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(248, 232, 220, 0.45)";
    ctx.fill();
  }
}

export function drawFaceFilter(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[] | null,
  filter: FaceFilterType,
  x: number,
  y: number,
  w: number,
  h: number,
  flipX: boolean | undefined,
  nowMs: number
) {
  if (filter === "none") return;
  if (!landmarks || landmarks.length < 455) return;

  const scale = (pt: { x: number; y: number }) => scaleToRect(pt, x, y, w, h, flipX);
  let leftEye = scale(centerOf(landmarks, LEFT_EYE));
  let rightEye = scale(centerOf(landmarks, RIGHT_EYE));
  if (flipX) [leftEye, rightEye] = [rightEye, leftEye];
  let cheekL = scale(centerOf(landmarks, LEFT_CHEEK));
  let cheekR = scale(centerOf(landmarks, RIGHT_CHEEK));
  if (flipX) [cheekL, cheekR] = [cheekR, cheekL];
  const leftBrowPts = polyScaled(landmarks, LEFT_BROW, scale);
  const rightBrowPts = polyScaled(landmarks, RIGHT_BROW, scale);
  const eyePolyIndices = filter === "rolleyes" ? LEFT_EYE_FULL : LEFT_EYE;
  const eyePolyIndicesR = filter === "rolleyes" ? RIGHT_EYE_FULL : RIGHT_EYE;
  const leftEyePoly = polyScaled(landmarks, eyePolyIndices, scale);
  const rightEyePoly = polyScaled(landmarks, eyePolyIndicesR, scale);
  const mouthOuterRing = polyScaled(landmarks, MOUTH_OUTER_RING, scale);

  const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  const sizeScale = eyeDist * 1.0;
  const cx = (leftEye.x + rightEye.x) / 2;
  const cy = (leftEye.y + rightEye.y) / 2;
  const faceAngle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(faceAngle);
  ctx.translate(-cx, -cy);

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
    ctx.ellipse(cx - glassW / 2 - bridgeW / 2, cy, glassW / 2, glassH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(cx + glassW / 2 + bridgeW / 2, cy, glassW / 2, glassH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - bridgeW / 2, cy - glassH * 0.3);
    ctx.lineTo(cx + bridgeW / 2, cy - glassH * 0.3);
    ctx.stroke();

    ctx.restore();
  } else if (filter === "heart") {
    drawTwinHearts(ctx, cx, cy, faceAngle, cheekL, cheekR, sizeScale, nowMs);
  } else if (filter === "firefly") {
    drawCheekMotes(ctx, cx, cy, faceAngle, cheekL, cheekR, sizeScale, nowMs);
  } else if (filter === "moustache") {
    drawFurryMouthBeard(ctx, cx, cy, faceAngle, mouthOuterRing, sizeScale);
  } else if (filter === "brows") {
    drawFurryBrows(ctx, cx, cy, faceAngle, leftBrowPts, rightBrowPts, sizeScale);
  } else if (filter === "rolleyes") {
    drawRollingEyesOverlay(ctx, leftEyePoly, rightEyePoly);
  }

  ctx.restore();
}
