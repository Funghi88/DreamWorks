import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

const DEFAULT_ALPHA = 0.82;

/** Stateful EMA smoother for face landmarks (used in the detection worker). */
export class LandmarkSmoother {
  private prev: NormalizedLandmark[] | null = null;

  reset(): void {
    this.prev = null;
  }

  smooth(raw: NormalizedLandmark[], alpha = DEFAULT_ALPHA): NormalizedLandmark[] {
    if (!this.prev || this.prev.length !== raw.length) {
      this.prev = raw.map((p) => ({ ...p }));
      return this.prev;
    }
    const out: NormalizedLandmark[] = [];
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      const b = this.prev[i];
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
    this.prev = out;
    return out;
  }

  smoothOrReset(raw: NormalizedLandmark[] | null, alpha = DEFAULT_ALPHA): NormalizedLandmark[] | null {
    if (!raw || raw.length < 455) {
      this.prev = null;
      return raw;
    }
    return this.smooth(raw, alpha);
  }
}

export function packLandmarksToFloat32(landmarks: NormalizedLandmark[]): Float32Array {
  const n = landmarks.length;
  const buf = new Float32Array(n * 4);
  let o = 0;
  for (const p of landmarks) {
    buf[o++] = p.x;
    buf[o++] = p.y;
    buf[o++] = p.z ?? 0;
    buf[o++] = p.visibility ?? 1;
  }
  return buf;
}

export function unpackLandmarksFromFloat32(buf: Float32Array, count: number): NormalizedLandmark[] {
  const out: NormalizedLandmark[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    out.push({
      x: buf[o],
      y: buf[o + 1],
      z: buf[o + 2],
      visibility: buf[o + 3],
    });
  }
  return out;
}
