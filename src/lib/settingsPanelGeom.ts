/** Persisted geometry for the floating Settings panel (CSS px relative to viewport). */

export type SettingsPanelGeom = { x: number; y: number; w: number; h: number };

const MIN_W = 300;
const MIN_H = 260;
export const SETTINGS_PANEL_MAX_W = 920;
export const SETTINGS_PANEL_MAX_H = 900;
const PAD = 10;

export function defaultSettingsPanelGeom(): SettingsPanelGeom {
  if (typeof window === "undefined") {
    return { x: 24, y: 24, w: 380, h: 560 };
  }
  const w = 380;
  const h = Math.min(SETTINGS_PANEL_MAX_H, Math.max(380, Math.round(window.innerHeight * 0.68)));
  return {
    x: Math.max(PAD, window.innerWidth - w - PAD),
    y: PAD,
    w,
    h,
  };
}

export function clampSettingsPanelGeom(g: SettingsPanelGeom): SettingsPanelGeom {
  let w = Math.min(SETTINGS_PANEL_MAX_W, Math.max(MIN_W, Math.round(g.w)));
  let h = Math.min(SETTINGS_PANEL_MAX_H, Math.max(MIN_H, Math.round(g.h)));
  if (typeof window === "undefined") {
    return { x: g.x, y: g.y, w, h };
  }
  const maxWuse = Math.max(MIN_W, window.innerWidth - PAD * 2);
  const maxHuse = Math.max(MIN_H, window.innerHeight - PAD * 2);
  w = Math.min(w, maxWuse);
  h = Math.min(h, maxHuse);
  const x = Math.min(Math.max(PAD, g.x), Math.max(PAD, window.innerWidth - w - PAD));
  const y = Math.min(Math.max(PAD, g.y), Math.max(PAD, window.innerHeight - h - PAD));
  return { x, y, w, h };
}

export function parseSettingsPanelGeom(raw: unknown): SettingsPanelGeom | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const x = typeof o.x === "number" ? o.x : NaN;
  const y = typeof o.y === "number" ? o.y : NaN;
  const w = typeof o.w === "number" ? o.w : NaN;
  const h = typeof o.h === "number" ? o.h : NaN;
  if ([x, y, w, h].some((n) => Number.isNaN(n))) return undefined;
  return clampSettingsPanelGeom({ x, y, w, h });
}
