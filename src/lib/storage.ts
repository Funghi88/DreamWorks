const KEY = "dreamwork-settings";

function getElectronAPI(): { getSettings: () => Promise<unknown>; saveSettings: (s: unknown) => Promise<void> } | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: { getSettings?: unknown; saveSettings?: unknown } }).electronAPI;
  return api?.getSettings && api?.saveSettings ? (api as { getSettings: () => Promise<unknown>; saveSettings: (s: unknown) => Promise<void> }) : null;
}

function validNum(n: unknown, min: number, max: number): number | undefined {
  return typeof n === "number" && n >= min && n <= max ? n : undefined;
}

function validBeautySettings(s: unknown): StoredBeautySettings | undefined {
  if (!s || typeof s !== "object") return undefined;
  const p = s as Record<string, unknown>;
  const skinSmoothing = validNum(p.skinSmoothing, 0, 100);
  const brighten = validNum(p.brighten, 0, 100);
  const glow = validNum(p.glow, 0, 100);
  const whiten = validNum(p.whiten, 0, 100);
  const contrast = validNum(p.contrast, 0, 100);
  const saturation = validNum(p.saturation, 0, 100);
  if (
    skinSmoothing === undefined ||
    brighten === undefined ||
    glow === undefined ||
    whiten === undefined ||
    contrast === undefined ||
    saturation === undefined
  )
    return undefined;
  return { skinSmoothing, brighten, glow, whiten, contrast, saturation };
}

export type StoredAvatarShape = "circle" | "rect";
export type StoredAvatarDecor = "none" | "simple" | "glow" | "dashed";

export interface StoredBeautySettings {
  skinSmoothing: number;
  brighten: number;
  glow: number;
  whiten: number;
  contrast: number;
  saturation: number;
}

export type RecordResolution = "1080p" | "2K" | "4K";

export type LetterboxBackground = "black" | "custom";

export interface StoredSettings {
  glowColor?: string;
  pipPos?: { x: number; y: number };
  fullPagePipPos?: { x: number; y: number };
  recordResolution?: RecordResolution;
  letterboxBackground?: LetterboxBackground;
  letterboxCustomImage?: string;
  previewPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  fullPagePreviewPos?: { x: number; y: number };
  sidebarWidth?: number;
  previewWidth?: number;
  whiteboardHeight?: number;
  avatarSize?: number;
  avatarShape?: StoredAvatarShape;
  avatarDecor?: StoredAvatarDecor;
  avatarImageSrc?: string;
  beautyMode?: boolean;
  beautySettings?: StoredBeautySettings;
  faceFilter?: "none" | "sunglasses" | "vampire" | "heart";
  micVolume?: number;
  systemVolume?: number;
}

function parseAndValidate(parsed: unknown): StoredSettings {
  if (!parsed || typeof parsed !== "object") return {};
  const p = parsed as Record<string, unknown>;
  return {
    glowColor: typeof p.glowColor === "string" ? p.glowColor : undefined,
    pipPos:
      p.pipPos && typeof (p.pipPos as { x?: number; y?: number }).x === "number" && typeof (p.pipPos as { x?: number; y?: number }).y === "number"
        ? (p.pipPos as { x: number; y: number })
        : undefined,
    fullPagePipPos:
      p.fullPagePipPos && typeof (p.fullPagePipPos as { x?: number; y?: number }).x === "number" && typeof (p.fullPagePipPos as { x?: number; y?: number }).y === "number"
        ? (p.fullPagePipPos as { x: number; y: number })
        : undefined,
    recordResolution: p.recordResolution === "1080p" || p.recordResolution === "2K" || p.recordResolution === "4K" ? (p.recordResolution as RecordResolution) : undefined,
    letterboxBackground:
      p.letterboxBackground && ["black", "custom"].includes(p.letterboxBackground as string)
        ? (p.letterboxBackground as LetterboxBackground)
        : undefined,
    letterboxCustomImage:
      typeof p.letterboxCustomImage === "string" &&
      (p.letterboxCustomImage.startsWith("data:image/") || p.letterboxCustomImage.startsWith("blob:"))
        ? p.letterboxCustomImage
        : undefined,
    previewPosition:
      p.previewPosition &&
      ["top-left", "top-right", "bottom-left", "bottom-right"].includes(p.previewPosition as string)
        ? (p.previewPosition as "top-left" | "top-right" | "bottom-left" | "bottom-right")
        : undefined,
    fullPagePreviewPos:
      p.fullPagePreviewPos &&
      typeof (p.fullPagePreviewPos as { x?: number; y?: number }).x === "number" &&
      typeof (p.fullPagePreviewPos as { x?: number; y?: number }).y === "number"
        ? (p.fullPagePreviewPos as { x: number; y: number })
        : undefined,
    sidebarWidth:
      typeof p.sidebarWidth === "number" && p.sidebarWidth >= 240 && p.sidebarWidth <= 600
        ? p.sidebarWidth
        : undefined,
    previewWidth:
      typeof p.previewWidth === "number" && p.previewWidth >= 80 && p.previewWidth <= 600
        ? p.previewWidth
        : undefined,
    whiteboardHeight:
      typeof p.whiteboardHeight === "number" && p.whiteboardHeight >= 120 && p.whiteboardHeight <= 800
        ? p.whiteboardHeight
        : undefined,
    avatarSize:
      typeof p.avatarSize === "number" && p.avatarSize >= 32 && p.avatarSize <= 280
        ? p.avatarSize
        : undefined,
    avatarShape:
      p.avatarShape === "circle" || p.avatarShape === "rect"
        ? (p.avatarShape as StoredAvatarShape)
        : undefined,
    avatarDecor:
      p.avatarDecor &&
      ["none", "simple", "glow", "dashed"].includes(p.avatarDecor as string)
        ? (p.avatarDecor as StoredAvatarDecor)
        : undefined,
    avatarImageSrc:
      typeof p.avatarImageSrc === "string" && p.avatarImageSrc.startsWith("data:image/")
        ? p.avatarImageSrc
        : undefined,
    beautyMode: typeof p.beautyMode === "boolean" ? p.beautyMode : undefined,
    beautySettings: validBeautySettings(p.beautySettings),
    faceFilter:
      p.faceFilter && ["none", "sunglasses", "vampire", "heart"].includes(p.faceFilter as string)
        ? (p.faceFilter as "none" | "sunglasses" | "vampire" | "heart")
        : undefined,
    micVolume:
      typeof p.micVolume === "number" && p.micVolume >= 0 && p.micVolume <= 100
        ? p.micVolume
        : undefined,
    systemVolume:
      typeof p.systemVolume === "number" &&
      p.systemVolume >= 0 &&
      p.systemVolume <= 100
        ? p.systemVolume
        : undefined,
  };
}

export function loadSettings(): StoredSettings {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return {};
    return parseAndValidate(JSON.parse(s));
  } catch {
    return {};
  }
}

/** Load settings from Electron file storage. Use on app mount when in Electron. */
export async function loadSettingsAsync(): Promise<StoredSettings> {
  const api = getElectronAPI();
  if (!api) return loadSettings();
  try {
    const raw = await api.getSettings();
    let s = parseAndValidate(raw);
    // Migrate from localStorage if file was empty (first run after upgrade)
    if (Object.keys(s).length === 0) {
      const fromLocal = loadSettings();
      if (Object.keys(fromLocal).length > 0) {
        s = fromLocal;
        api.saveSettings(s).catch(() => {});
      }
    }
    return s;
  } catch {
    return loadSettings();
  }
}

export function saveSettings(settings: StoredSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  const api = getElectronAPI();
  if (api) {
    api.saveSettings(settings).catch(() => {});
  }
}
