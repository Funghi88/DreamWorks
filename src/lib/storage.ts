import type { SettingsPanelGeom } from "@/lib/settingsPanelGeom";
import { parseSettingsPanelGeom } from "@/lib/settingsPanelGeom";

const KEY = "dreamwork-settings";

/** Latest full settings (last `saveSettings` or disk hydrate). Used instead of rereading LS mid-flight so e.g. Teleprompter save cannot wipe in-memory whiteboard data. */
let persistedSettingsSnapshot: StoredSettings | null = null;

export const DREAMWORK_FLUSH_TELEPROMPTER_DRAFT = "dreamwork-flush-teleprompter-draft";

export function hydratePersistedSettingsSnapshot(s: StoredSettings): void {
  persistedSettingsSnapshot = { ...s };
}

/** Merge base for partial saves — prefer last persisted blob over `loadSettings()` to avoid cross-feature clobber. */
export function getSettingsMergeBase(): StoredSettings {
  return persistedSettingsSnapshot ?? loadSettings();
}

function getElectronAPI(): { getSettings: () => Promise<unknown>; saveSettings: (s: unknown) => Promise<void> } | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: { getSettings?: unknown; saveSettings?: unknown } }).electronAPI;
  return api?.getSettings && api?.saveSettings ? (api as { getSettings: () => Promise<unknown>; saveSettings: (s: unknown) => Promise<void> }) : null;
}

function validNum(n: unknown, min: number, max: number): number | undefined {
  return typeof n === "number" && n >= min && n <= max ? n : undefined;
}

/** Saved values far above a plausible side strip were mistaken layout widths (debug 1b8595); normalize to default min. */
function normalizeWhiteboardStripWidth(n: number): number {
  return n > 500 ? 40 : n;
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

export type StoredAvatarShape = "circle" | "rect" | "portrait";
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

/** Landscape: explicit 16∶9 or 16∶10 encode sizes; portrait → fixed 3∶4 / 9∶16 (short-edge tiers). */
export type RecordOutputShape =
  | "landscape_16_9"
  | "landscape_16_10"
  | "portrait_3_4"
  | "portrait_9_16";

export function isLandscapeRecordOutputShape(s: RecordOutputShape): boolean {
  return s === "landscape_16_9" || s === "landscape_16_10";
}

export function isPortraitRecordOutputShape(s: RecordOutputShape): boolean {
  return s === "portrait_3_4" || s === "portrait_9_16";
}

/** Legacy saved `"landscape"` → pick table by primary screen aspect (same threshold as detectScreenOutputAspectFamily). */
function migrateStoredLandscapeRecordShape(): "landscape_16_9" | "landscape_16_10" {
  if (typeof window !== "undefined" && window.screen) {
    const sw = window.screen.width;
    const sh = window.screen.height;
    if (sw > 0 && sh > 0 && sw / sh < 1.72) return "landscape_16_10";
  }
  return "landscape_16_9";
}

function parseRecordOutputShape(raw: unknown): RecordOutputShape | undefined {
  if (raw === "landscape_16_9" || raw === "landscape_16_10" || raw === "portrait_3_4" || raw === "portrait_9_16") {
    return raw;
  }
  if (raw === "landscape") return migrateStoredLandscapeRecordShape();
  return undefined;
}

export type LetterboxBackground = "black" | "custom";
/** Custom background (and non–screen-share composites): fit = contain, crop = cover, fill = stretch. */
export type LetterboxMode = "fill" | "fit" | "crop";

export type WhiteboardLayer = { id: string; name: string };

export interface StoredSettings {
  glowColor?: string;
  pipPos?: { x: number; y: number };
  fullPagePipPos?: { x: number; y: number };
  recordResolution?: RecordResolution;
  recordOutputShape?: RecordOutputShape;
  /** Share window / whiteboard-only record: width & height scale vs output frame (40–100%). Higher = sharper, less margin. */
  shareWindowFillPercent?: number;
  /** Pan share window inside letterbox ([-1,1] × [-1,1], 0 = centered). Landscape & portrait Capture. */
  sharePortraitWindowPanNorm?: { x: number; y: number };
  /** Whiteboard-only record: pan fitted whiteboard surface inside output slack (same norm as share pan). */
  whiteboardRecordSurfacePanNorm?: { x: number; y: number };
  letterboxBackground?: LetterboxBackground;
  letterboxCustomImage?: string;
  letterboxMode?: LetterboxMode;
  previewPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  previewLayoutMode?: "overlay" | "side-right" | "side-bottom";
  fullPagePreviewPos?: { x: number; y: number };
  sidebarWidth?: number;
  previewWidth?: number;
  whiteboardPanelWidth?: number;
  /**
   * After first read, strip width follows user drags. Absent on legacy files → one-time migrate:
   * keep saved `whiteboardPanelWidth` if present, else default 40px (first install).
   */
  splitStripWidthInitialized?: boolean;
  capturePanelWidth?: number;
  whiteboardHeight?: number;
  avatarSize?: number;
  avatarShape?: StoredAvatarShape;
  avatarDecor?: StoredAvatarDecor;
  avatarImageSrc?: string;
  beautyMode?: boolean;
  beautySettings?: StoredBeautySettings;
  faceFilter?:
    | "none"
    | "sunglasses"
    | "firefly"
    | "heart"
    | "moustache"
    | "brows"
    | "rolleyes";
  /** PiP AR: built-in MediaPipe overlays vs Snap Camera Kit (env-gated). */
  pipEffectBackend?: "mediapipe" | "snap";
  micVolume?: number;
  systemVolume?: number;
  /** When true, exported recording omits the in-app PiP (use macOS presenter / camera overlay in your meeting app instead). */
  omitPipFromRecording?: boolean;
  /** When true, starting a recording moves PiP to the whiteboard column (off the shared capture area when screen sharing). */
  autoParkPipOnRecordStart?: boolean;
  /** Floating Settings panel geometry (CSS px, viewport). */
  settingsPanelGeom?: SettingsPanelGeom;
  /** @deprecated Migrated to whiteboardProjects */
  whiteboardData?: { elements: unknown[]; appState: Record<string, unknown>; files?: Record<string, unknown> };
  /** Whiteboard projects: one document per project */
  whiteboardProjects?: Array<{
    id: string;
    name: string;
    /** Electron: last .excalidraw path for this project (⌘S overwrites; unset → next save opens Save dialog). */
    diskPath?: string;
    data: {
      elements: unknown[];
      appState: Record<string, unknown>;
      files?: Record<string, unknown>;
      /** DreamWorks backup: texture + full files map (Excalidraw may omit from sibling keys). */
      dreamwork?: { v: 1; whiteboardTexture?: string; files?: Record<string, unknown> };
      layers?: WhiteboardLayer[];
      layerAssignments?: Record<string, string>;
      hiddenLayerIds?: string[];
    };
    updatedAt: number;
  }>;
  activeProjectId?: string;
  /** @deprecated Migrated to teleprompterScripts */
  teleprompterScript?: string;
  /** Teleprompter scripts: multiple named scripts */
  teleprompterScripts?: Array<{ id: string; name: string; content: string; updatedAt: number }>;
  activeTeleprompterScriptId?: string;
  teleprompterSpeed?: number;
  teleprompterFontSize?: number;
  teleprompterOpacity?: number;
  teleprompterWidth?: number;
  teleprompterHeight?: number;
  /** Control panel (editor) size — separate from floating overlay width/height */
  teleprompterPanelWidth?: number;
  teleprompterPanelHeight?: number;
  /** Vosk model folder preference; `auto` resolves from script (CJK → zh). */
  teleprompterVoskLang?: "en" | "zh" | "it" | "auto";
}

export type WhiteboardProject = NonNullable<StoredSettings["whiteboardProjects"]>[number];
export type TeleprompterScript = NonNullable<StoredSettings["teleprompterScripts"]>[number];

function validLayers(v: unknown): WhiteboardLayer[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WhiteboardLayer[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== "string" || typeof p.name !== "string") continue;
    out.push({ id: p.id, name: p.name });
  }
  return out.length ? out : undefined;
}

function validWhiteboardData(v: unknown): StoredSettings["whiteboardData"] {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.elements) || !p.appState || typeof p.appState !== "object") return undefined;
  const appState = p.appState as Record<string, unknown>;
  const { collaborators: _, ...rest } = appState;
  const files = p.files && typeof p.files === "object" ? (p.files as Record<string, unknown>) : undefined;
  const layers = validLayers(p.layers);
  const layerAssignments =
    p.layerAssignments && typeof p.layerAssignments === "object"
      ? (p.layerAssignments as Record<string, string>)
      : undefined;
  const hiddenLayerIds =
    Array.isArray(p.hiddenLayerIds) && p.hiddenLayerIds.every((x) => typeof x === "string")
      ? (p.hiddenLayerIds as string[])
      : undefined;
  let dreamwork: { v: 1; whiteboardTexture?: string; files?: Record<string, unknown> } | undefined;
  const dwRaw = p.dreamwork;
  if (dwRaw && typeof dwRaw === "object" && (dwRaw as { v?: unknown }).v === 1) {
    const d = dwRaw as Record<string, unknown>;
    const dt =
      typeof d.whiteboardTexture === "string" && d.whiteboardTexture.length > 0 ? d.whiteboardTexture : undefined;
    const dfs = d.files && typeof d.files === "object" && !Array.isArray(d.files) ? (d.files as Record<string, unknown>) : undefined;
    if (dt || (dfs && Object.keys(dfs).length > 0)) {
      dreamwork = {
        v: 1,
        ...(dt ? { whiteboardTexture: dt } : {}),
        ...(dfs && Object.keys(dfs).length > 0 ? { files: dfs } : {}),
      };
    }
  }
  return {
    elements: p.elements,
    appState: rest,
    ...(files && Object.keys(files).length > 0 ? { files } : {}),
    ...(dreamwork ? { dreamwork } : {}),
    ...(layers ? { layers } : {}),
    ...(layerAssignments ? { layerAssignments } : {}),
    ...(hiddenLayerIds?.length ? { hiddenLayerIds } : {}),
  };
}

function validProjects(v: unknown): StoredSettings["whiteboardProjects"] {
  if (!Array.isArray(v)) return undefined;
  const out: WhiteboardProject[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== "string" || typeof p.name !== "string" || typeof p.updatedAt !== "number") continue;
    const data = validWhiteboardData(p.data);
    if (!data) continue;
    const name = p.name === "未命名项目" ? "Untitled" : p.name;
    const diskPath =
      typeof p.diskPath === "string" && p.diskPath.length > 0 ? p.diskPath : undefined;
    out.push({
      id: p.id,
      name,
      data,
      updatedAt: p.updatedAt,
      ...(diskPath ? { diskPath } : {}),
    });
  }
  return out.length ? out : undefined;
}

function validTeleprompterScripts(v: unknown): StoredSettings["teleprompterScripts"] {
  if (!Array.isArray(v)) return undefined;
  const out: TeleprompterScript[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== "string" || typeof p.name !== "string" || typeof p.content !== "string" || typeof p.updatedAt !== "number") continue;
    out.push({ id: p.id, name: p.name, content: p.content, updatedAt: p.updatedAt });
  }
  return out.length ? out : undefined;
}

function parseAndValidate(parsed: unknown): StoredSettings {
  if (!parsed || typeof parsed !== "object") return {};
  const p = parsed as Record<string, unknown>;
  const SPLIT_STRIP_DEFAULT_PX = 40;
  const base: StoredSettings = {
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
    recordOutputShape: parseRecordOutputShape(p.recordOutputShape),
    shareWindowFillPercent: validNum(p.shareWindowFillPercent, 40, 100),
    sharePortraitWindowPanNorm: (() => {
      const raw = p.sharePortraitWindowPanNorm;
      if (!raw || typeof raw !== "object") return undefined;
      const o = raw as Record<string, unknown>;
      const x = typeof o.x === "number" ? o.x : NaN;
      const y = typeof o.y === "number" ? o.y : NaN;
      if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
      const cx = Math.min(1, Math.max(-1, x));
      const cy = Math.min(1, Math.max(-1, y));
      return { x: cx, y: cy };
    })(),
    whiteboardRecordSurfacePanNorm: (() => {
      const raw = p.whiteboardRecordSurfacePanNorm;
      if (!raw || typeof raw !== "object") return undefined;
      const o = raw as Record<string, unknown>;
      const x = typeof o.x === "number" ? o.x : NaN;
      const y = typeof o.y === "number" ? o.y : NaN;
      if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
      return { x: Math.min(1, Math.max(-1, x)), y: Math.min(1, Math.max(-1, y)) };
    })(),
    settingsPanelGeom: parseSettingsPanelGeom(p.settingsPanelGeom),
    letterboxBackground:
      p.letterboxBackground && ["black", "custom"].includes(p.letterboxBackground as string)
        ? (p.letterboxBackground as LetterboxBackground)
        : undefined,
    letterboxCustomImage:
      typeof p.letterboxCustomImage === "string" &&
      (p.letterboxCustomImage.startsWith("data:image/") || p.letterboxCustomImage.startsWith("blob:"))
        ? p.letterboxCustomImage
        : undefined,
    letterboxMode: (() => {
      const m = p.letterboxMode;
      if (m === "fill" || m === "fit" || m === "crop") return m as LetterboxMode;
      // Backward compatibility with previous naming.
      if (m === "stretch") return "fill";
      if (m === "contain") return "fit";
      if (m === "cover") return "crop";
      return undefined;
    })(),
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
    previewLayoutMode:
      p.previewLayoutMode &&
      ["overlay", "side-right", "side-bottom"].includes(p.previewLayoutMode as string)
        ? (p.previewLayoutMode as "overlay" | "side-right" | "side-bottom")
        : undefined,
    sidebarWidth:
      typeof p.sidebarWidth === "number" && p.sidebarWidth >= 240 && p.sidebarWidth <= 600
        ? p.sidebarWidth
        : undefined,
    previewWidth:
      typeof p.previewWidth === "number" && p.previewWidth >= 80 && p.previewWidth <= 600
        ? p.previewWidth
        : undefined,
    whiteboardPanelWidth: (() => {
      const raw =
        typeof p.whiteboardPanelWidth === "number" && p.whiteboardPanelWidth >= 40 && p.whiteboardPanelWidth <= 800
          ? p.whiteboardPanelWidth
          : undefined;
      return raw !== undefined ? normalizeWhiteboardStripWidth(raw) : undefined;
    })(),
    capturePanelWidth:
      typeof p.capturePanelWidth === "number" && p.capturePanelWidth >= 60 && p.capturePanelWidth <= 600
        ? p.capturePanelWidth
        : undefined,
    whiteboardHeight:
      typeof p.whiteboardHeight === "number" && p.whiteboardHeight >= 120 && p.whiteboardHeight <= 800
        ? p.whiteboardHeight
        : undefined,
    avatarSize:
      typeof p.avatarSize === "number" && p.avatarSize >= 32 && p.avatarSize <= 400
        ? p.avatarSize
        : undefined,
    avatarShape:
      p.avatarShape === "circle" || p.avatarShape === "rect" || p.avatarShape === "portrait"
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
    faceFilter: (() => {
      const v = p.faceFilter;
      if (!v || typeof v !== "string") return undefined;
      if (v === "vampire") return "firefly";
      if (
        [
          "none",
          "sunglasses",
          "firefly",
          "heart",
          "moustache",
          "brows",
          "rolleyes",
        ].includes(v)
      )
        return v as StoredSettings["faceFilter"];
      return undefined;
    })(),
    pipEffectBackend:
      p.pipEffectBackend === "snap" || p.pipEffectBackend === "mediapipe"
        ? p.pipEffectBackend
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
    omitPipFromRecording: typeof p.omitPipFromRecording === "boolean" ? p.omitPipFromRecording : undefined,
    autoParkPipOnRecordStart:
      typeof p.autoParkPipOnRecordStart === "boolean" ? p.autoParkPipOnRecordStart : undefined,
    whiteboardData: validWhiteboardData(p.whiteboardData),
    whiteboardProjects: validProjects(p.whiteboardProjects),
    activeProjectId: typeof p.activeProjectId === "string" ? p.activeProjectId : undefined,
    teleprompterScript: typeof p.teleprompterScript === "string" ? p.teleprompterScript : undefined,
    teleprompterScripts: validTeleprompterScripts(p.teleprompterScripts),
    activeTeleprompterScriptId: typeof p.activeTeleprompterScriptId === "string" ? p.activeTeleprompterScriptId : undefined,
    teleprompterSpeed: validNum(p.teleprompterSpeed, 10, 80),
    teleprompterFontSize: validNum(p.teleprompterFontSize, 18, 52),
    teleprompterOpacity: typeof p.teleprompterOpacity === "number" && p.teleprompterOpacity >= 0.35 && p.teleprompterOpacity <= 1 ? p.teleprompterOpacity : undefined,
    teleprompterWidth: validNum(p.teleprompterWidth, 320, 900),
    teleprompterHeight: validNum(p.teleprompterHeight, 180, 500),
    teleprompterPanelWidth: validNum(p.teleprompterPanelWidth, 280, 920),
    teleprompterPanelHeight: validNum(p.teleprompterPanelHeight, 320, 900),
    teleprompterVoskLang:
      p.teleprompterVoskLang === "zh" ||
      p.teleprompterVoskLang === "it" ||
      p.teleprompterVoskLang === "en" ||
      p.teleprompterVoskLang === "auto"
        ? p.teleprompterVoskLang
        : undefined,
  };

  if (p.splitStripWidthInitialized === true) {
    return { ...base, splitStripWidthInitialized: true };
  }
  const migrated: StoredSettings = {
    ...base,
    splitStripWidthInitialized: true,
    ...(base.whiteboardPanelWidth == null ? { whiteboardPanelWidth: SPLIT_STRIP_DEFAULT_PX } : {}),
  };
  return migrated;
}

/** Get teleprompter scripts with migration from legacy teleprompterScript. */
export function getTeleprompterScripts(s: StoredSettings): TeleprompterScript[] {
  if (s.teleprompterScripts?.length) return s.teleprompterScripts;
  if (typeof s.teleprompterScript === "string") {
    return [
      {
        id: "migrated-" + Date.now(),
        name: "Untitled",
        content: s.teleprompterScript,
        updatedAt: Date.now(),
      },
    ];
  }
  return [{ id: "default", name: "Untitled", content: "Hook line.\n\nMain point one.\n\nMain point two.\n\nCall to action.", updatedAt: Date.now() }];
}

export function saveTeleprompterScripts(
  s: StoredSettings,
  scripts: TeleprompterScript[],
  activeId: string
): StoredSettings {
  const next = { ...s, teleprompterScripts: scripts, activeTeleprompterScriptId: activeId };
  if (next.teleprompterScript) delete next.teleprompterScript;
  return next;
}

/** Get projects with migration from legacy whiteboardData. Call after parseAndValidate. */
export function getWhiteboardProjects(s: StoredSettings): WhiteboardProject[] {
  if (s.whiteboardProjects?.length) return s.whiteboardProjects;
  if (s.whiteboardData) {
    const migrated: WhiteboardProject = {
      id: "migrated-" + Date.now(),
      name: "Untitled",
      data: s.whiteboardData,
      updatedAt: Date.now(),
    };
    return [migrated];
  }
  return [{ id: "default", name: "Untitled", data: { elements: [], appState: {} }, updatedAt: Date.now() }];
}

export function saveWhiteboardProjects(
  s: StoredSettings,
  projects: WhiteboardProject[],
  activeId: string
): StoredSettings {
  const next = { ...s, whiteboardProjects: projects, activeProjectId: activeId };
  if (next.whiteboardData) delete next.whiteboardData;
  return next;
}

export function loadSettings(): StoredSettings {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return parseAndValidate({});
    return parseAndValidate(JSON.parse(s));
  } catch {
    return parseAndValidate({});
  }
}

/** Load settings from Electron file storage. Use on app mount when in Electron. */
export async function loadSettingsAsync(): Promise<StoredSettings> {
  const api = getElectronAPI();
  if (!api) return loadSettings();
  try {
    const raw = await api.getSettings();
    const hadSplitStripInit =
      raw != null && typeof raw === "object" && (raw as Record<string, unknown>).splitStripWidthInitialized === true;
    let s = parseAndValidate(raw);
    // Migrate from localStorage if file was empty (first run after upgrade)
    if (Object.keys(s).length === 0) {
      const fromLocal = loadSettings();
      if (Object.keys(fromLocal).length > 0) {
        s = fromLocal;
        api.saveSettings(s).catch(() => {});
      }
    }
    if (!hadSplitStripInit && s.splitStripWidthInitialized === true) {
      api.saveSettings(s).catch(() => {});
    }
    // Electron: disk is source of truth; mirror into localStorage so loadSettings() matches.
    // Otherwise App's UI auto-save used {} from LS and overwrote whiteboardProjects + images on disk.
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* quota */
    }
    hydratePersistedSettingsSnapshot(s);
    return s;
  } catch {
    const fallback = loadSettings();
    hydratePersistedSettingsSnapshot(fallback);
    return fallback;
  }
}

export function saveSettings(settings: StoredSettings) {
  persistedSettingsSnapshot = settings;
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
