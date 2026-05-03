/**
 * User-facing Vosk preference may include "auto" for mixed 中/英 scripts.
 * IPC / native path only accepts en | zh | it.
 */
export type StoredTeleprompterVoskLang = "en" | "zh" | "it" | "auto";

export function isStoredTeleprompterVoskLang(v: unknown): v is StoredTeleprompterVoskLang {
  return v === "en" || v === "zh" || v === "it" || v === "auto";
}

/** Pick model folder: mixed or CJK-heavy → zh (English segments may be imperfect). Pure Latin → en. */
export function resolveTeleprompterVoskModelLang(
  script: string,
  pref: StoredTeleprompterVoskLang
): "en" | "zh" | "it" {
  if (pref === "en" || pref === "zh" || pref === "it") return pref;
  if (/[\u4e00-\u9fff]/.test(script)) return "zh";
  return "en";
}
