import type { RecordResolution } from "@/lib/storage";

/** iMac / 多数外接屏 ≈16:9；MacBook 内置屏 ≈16:10 */
export type OutputAspectFamily = "16:9" | "16:10";

const SIZES_16_9: Record<RecordResolution, { w: number; h: number }> = {
  "1080p": { w: 1920, h: 1080 },
  "2K": { w: 2560, h: 1440 },
  "4K": { w: 3840, h: 2160 },
};

const SIZES_16_10: Record<RecordResolution, { w: number; h: number }> = {
  "1080p": { w: 1920, h: 1200 },
  "2K": { w: 2560, h: 1600 },
  "4K": { w: 3840, h: 2400 },
};

/**
 * `sysctl -n hw.model` on Apple Silicon / Intel Mac, e.g. `MacBookPro18,1`, `MacBookAir10,1`.
 */
export function isMacBookProOrAirModel(hwModel: string | null | undefined): boolean {
  if (!hwModel || typeof hwModel !== "string") return false;
  const m = hwModel.trim();
  return /^MacBookPro\d/i.test(m) || /^MacBookAir\d/i.test(m);
}

/**
 * 根据主屏宽高比粗分：16:10 ≈1.6（MacBook），16:9 ≈1.78（iMac 等）。
 * 阈值取中间，避免边界抖动。
 */
export function detectScreenOutputAspectFamily(): OutputAspectFamily {
  if (typeof window === "undefined" || !window.screen) return "16:9";
  const sw = window.screen.width;
  const sh = window.screen.height;
  if (sw <= 0 || sh <= 0) return "16:9";
  const ratio = sw / sh;
  return ratio < 1.72 ? "16:10" : "16:9";
}

/**
 * 成片宽高比：MacBook Pro / Air → 固定 16:10 输出表；否则按主屏比例在 16:9 / 16:10 间选择。
 * 与 {@link getRecordOutputDimensions} 及 Share 区域占满度框共用同一 family。
 */
export function resolveOutputAspectFamily(options: {
  hardwareModel?: string | null;
}): OutputAspectFamily {
  if (isMacBookProOrAirModel(options.hardwareModel)) {
    return "16:10";
  }
  return detectScreenOutputAspectFamily();
}

export function getRecordOutputDimensions(
  preset: RecordResolution,
  family: OutputAspectFamily
): { w: number; h: number } {
  const table = family === "16:10" ? SIZES_16_10 : SIZES_16_9;
  return table[preset] ?? table["1080p"];
}

/**
 * Largest axis-aligned rectangle with aspect `aspectW:aspectH` that fits inside `boxW × boxH` (CSS px).
 * Used so canvas display size matches bitmap aspect → uniform browser scaling (no horizontal/vertical stretch).
 */
export function fitRectWithAspectInside(
  boxW: number,
  boxH: number,
  aspectW: number,
  aspectH: number
): { w: number; h: number } {
  const bw = Math.max(1, boxW);
  const bh = Math.max(1, boxH);
  const aw = Math.max(1, aspectW);
  const ah = Math.max(1, aspectH);
  const A = aw / ah;
  if (bw / bh > A) {
    return { w: bh * A, h: bh };
  }
  return { w: bw, h: bw / A };
}

/**
 * Width = boxW, height = boxW / (aspectW/aspectH). Fills column width; height may exceed boxH.
 * Parent should use overflow:hidden — clips top/bottom instead of leaving side gutters (vs height-first inside fit).
 */
export function fitRectWithAspectToBoxWidth(
  boxW: number,
  _boxH: number,
  aspectW: number,
  aspectH: number
): { w: number; h: number } {
  const bw = Math.max(1, boxW);
  const aw = Math.max(1, aspectW);
  const ah = Math.max(1, aspectH);
  const A = aw / ah;
  const w = bw;
  const h = w / A;
  return { w, h };
}
