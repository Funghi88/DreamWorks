/**
 * Same math as screen capture recording: target width = 80% of output frame,
 * height scales by content aspect ratio, centered in the frame.
 */
export function recordContentFit80(
  frameW: number,
  frameH: number,
  contentW: number,
  contentH: number
): { dw: number; dh: number; dx: number; dy: number } {
  const cw = Math.max(1, contentW);
  const ch = Math.max(1, contentH);
  const targetW = Math.round(frameW * 0.8);
  const scale = targetW / cw;
  const dw = targetW;
  const dh = Math.round(ch * scale);
  const dx = Math.round((frameW - dw) / 2);
  const dy = Math.round((frameH - dh) / 2);
  return { dw, dh, dx, dy };
}
