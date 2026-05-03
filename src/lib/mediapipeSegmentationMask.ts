/**
 * MediaPipe ImageSegmenter (deeplab_v3) may expose mask[0] as **background** or **person** confidence
 * depending on build. Treating person-confidence as background replaces the face with the virtual bg.
 */

export type SegmentationMaskSemantics = "background" | "person";

/** Sample central band (typical face region): high mean ⇒ mask tracks foreground/person. */
export function inferSegmentationMaskSemantics(
  maskData: Float32Array,
  maskW: number,
  maskH: number,
  w: number,
  h: number,
  scaleX: number,
  scaleY: number
): SegmentationMaskSemantics {
  let s = 0;
  let n = 0;
  for (let yy = Math.floor(h * 0.28); yy < Math.floor(h * 0.62); yy += 6) {
    for (let xx = Math.floor(w * 0.35); xx < Math.floor(w * 0.65); xx += 6) {
      const mx = Math.min(Math.floor(xx * scaleX), maskW - 1);
      const my = Math.min(Math.floor(yy * scaleY), maskH - 1);
      s += maskData[my * maskW + mx] ?? 0;
      n++;
    }
  }
  const avg = n > 0 ? s / n : 0.5;
  return avg > 0.42 ? "person" : "background";
}

/** True if this pixel should show the virtual background (blur/color/image), not the raw camera. */
export function isSegmentationBackground(
  maskValue: number,
  semantics: SegmentationMaskSemantics,
  threshold: number
): boolean {
  if (semantics === "background") {
    return maskValue > threshold;
  }
  return maskValue < threshold;
}
