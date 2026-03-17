/** Main capture modes (2K resolution) */
export const CAPTURE_MODES = [
  { id: "preview", label: "Preview (2K)" },
] as const;

/** Preset dimensions for crop capture (e.g. social media covers) - applies to preview */
export const CAPTURE_PRESETS = [
  { id: "avatar", label: "Avatar 400×400", w: 400, h: 400 },
  { id: "bg", label: "Background 1000×800", w: 1000, h: 800 },
  { id: "cover-v", label: "Cover vertical 1242×1660", w: 1242, h: 1660 },
  { id: "cover-sq", label: "Cover square 1080×1080", w: 1080, h: 1080 },
  { id: "cover-h", label: "Cover horizontal 1200×900", w: 1200, h: 900 },
  { id: "video-v", label: "Video cover vertical 1080×1440", w: 1080, h: 1440 },
  { id: "video-h-43", label: "Video cover horizontal 1440×1080", w: 1440, h: 1080 },
  { id: "video-h-169", label: "Video cover horizontal 1920×1080", w: 1920, h: 1080 },
] as const;

export type CapturePresetId = (typeof CAPTURE_PRESETS)[number]["id"];
export type CaptureModeId = (typeof CAPTURE_MODES)[number]["id"];

/**
 * Capture current composite frame, optionally crop to preset size (center crop).
 * Returns PNG blob.
 */
export function captureFrame(
  canvas: HTMLCanvasElement,
  presetId: CapturePresetId
): Promise<Blob> {
  const preset = CAPTURE_PRESETS.find((p) => p.id === presetId);
  const sw = canvas.width;
  const sh = canvas.height;
  if (sw <= 0 || sh <= 0) {
    return Promise.reject(new Error("Canvas has no content"));
  }

  if (!preset) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Capture failed"))),
        "image/png",
        1
      );
    });
  }

  const targetW = preset.w;
  const targetH = preset.h;
  const srcAspect = sw / sh;
  const dstAspect = targetW / targetH;

  let sx: number;
  let sy: number;
  let sW: number;
  let sH: number;

  if (srcAspect > dstAspect) {
    sH = sh;
    sW = sh * dstAspect;
    sx = (sw - sW) / 2;
    sy = 0;
  } else {
    sW = sw;
    sH = sw / dstAspect;
    sx = 0;
    sy = (sh - sH) / 2;
  }

  const off = document.createElement("canvas");
  off.width = targetW;
  off.height = targetH;
  const ctx = off.getContext("2d", { alpha: false });
  if (!ctx) return Promise.reject(new Error("Could not create canvas context"));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, sx, sy, sW, sH, 0, 0, targetW, targetH);

  return new Promise((resolve, reject) => {
    off.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Capture failed"))),
      "image/png",
      1
    );
  });
}

export function getCaptureFilename(presetId: CapturePresetId | CaptureModeId): string {
  if (presetId === "preview") return `dreamwork-preview-2560x1440-${Date.now()}.png`;
  const preset = CAPTURE_PRESETS.find((p) => p.id === presetId);
  const dims = preset && preset.w > 0 ? `${preset.w}x${preset.h}` : "original";
  return `dreamwork-capture-${dims}-${Date.now()}.png`;
}

const CAPTURE_2K_LANDSCAPE = { w: 2560, h: 1440 };
const CAPTURE_2K_PORTRAIT = { w: 1440, h: 2560 };

/** Scale a canvas/image to 2K (preserves aspect: landscape 2560×1440, portrait 1440×2560) */
export function scaleTo2KAndBlob(source: HTMLCanvasElement | HTMLVideoElement): Promise<{ blob: Blob; w: number; h: number }> {
  const sw = "videoWidth" in source ? source.videoWidth : source.width;
  const sh = "videoHeight" in source ? source.videoHeight : source.height;
  if (sw <= 0 || sh <= 0) return Promise.reject(new Error("Source has no content"));
  const isPortrait = sh > sw;
  const { w, h } = isPortrait ? CAPTURE_2K_PORTRAIT : CAPTURE_2K_LANDSCAPE;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d", { alpha: false });
  if (!ctx) return Promise.reject(new Error("Could not create canvas context"));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    off.toBlob(
      (blob) => (blob ? resolve({ blob, w, h }) : reject(new Error("Capture failed"))),
      "image/png",
      1
    );
  });
}
