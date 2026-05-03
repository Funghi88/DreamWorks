import { describe, expect, it } from "vitest";
import { downsampleFloatTo16kMono } from "./teleprompterMicTo16k";

describe("downsampleFloatTo16kMono", () => {
  it("passes through at 16k", () => {
    const f = new Float32Array([0, 0.5, -0.5]);
    const o = downsampleFloatTo16kMono(f, 16000);
    expect(o.length).toBe(3);
    expect(o[1]).toBeGreaterThan(0);
  });

  it("downsamples 48k to fewer samples", () => {
    const f = new Float32Array(4800);
    for (let i = 0; i < f.length; i++) f[i] = Math.sin(i / 10);
    const o = downsampleFloatTo16kMono(f, 48000);
    expect(o.length).toBe(1600);
  });
});
