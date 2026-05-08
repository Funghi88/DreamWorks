import type { RecordResolution, RecordOutputShape } from "@/lib/storage";

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

/** Portrait 3:4 — short edge 1080 / 1440 / 2160 for 1080p / 2K / 4K tier. */
const SIZES_PORTRAIT_3_4: Record<RecordResolution, { w: number; h: number }> = {
  "1080p": { w: 1080, h: 1440 },
  "2K": { w: 1440, h: 1920 },
  "4K": { w: 2160, h: 2880 },
};

/** Portrait 9:16 — same short-edge tiers. */
const SIZES_PORTRAIT_9_16: Record<RecordResolution, { w: number; h: number }> = {
  "1080p": { w: 1080, h: 1920 },
  "2K": { w: 1440, h: 2560 },
  "4K": { w: 2160, h: 3840 },
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
 * MacBook Pro / Air → 16∶10 family hint；否则按主屏比例。可用于 UI 提示；成片尺寸见 {@link getRecordOutputDimensions} 与 Settings 中的 Frame 选项。
 */
export function resolveOutputAspectFamily(options: {
  hardwareModel?: string | null;
}): OutputAspectFamily {
  if (isMacBookProOrAirModel(options.hardwareModel)) {
    return "16:10";
  }
  return detectScreenOutputAspectFamily();
}

/** 编码成片像素尺寸（由 Res + Frame shape 唯一决定）。 */
export function getRecordOutputDimensions(
  preset: RecordResolution,
  outputShape: RecordOutputShape = "landscape_16_9"
): { w: number; h: number } {
  if (outputShape === "portrait_3_4") {
    return SIZES_PORTRAIT_3_4[preset] ?? SIZES_PORTRAIT_3_4["1080p"];
  }
  if (outputShape === "portrait_9_16") {
    return SIZES_PORTRAIT_9_16[preset] ?? SIZES_PORTRAIT_9_16["1080p"];
  }
  if (outputShape === "landscape_16_10") {
    return SIZES_16_10[preset] ?? SIZES_16_10["1080p"];
  }
  return SIZES_16_9[preset] ?? SIZES_16_9["1080p"];
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
