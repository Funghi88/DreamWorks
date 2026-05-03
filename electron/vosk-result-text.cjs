"use strict";

/**
 * Vosk FFI returns JSON strings; the npm Recognizer wraps JSON.parse so callers get objects.
 * Partial/final payloads may use `partial`, `text`, and/or `result[].word` depending on model/state.
 */

function parseVoskJson(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function wordsFromResultArray(r) {
  if (!Array.isArray(r)) return "";
  const words = r
    .map((w) => (w && typeof w.word === "string" ? w.word : ""))
    .filter(Boolean);
  return words.length ? words.join(" ") : "";
}

/** n-best final shape: `{ "alternatives": [{ "text": "...", "confidence": 0.9 }] }` */
function firstAlternativeText(o) {
  const alts = o.alternatives;
  if (!Array.isArray(alts) || alts.length === 0) return "";
  const t = alts[0] && alts[0].text;
  return typeof t === "string" ? t.trim() : "";
}

function voskFinalText(obj) {
  const o = parseVoskJson(obj);
  if (!o || typeof o !== "object") return "";
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  const fromArr = wordsFromResultArray(o.result);
  if (fromArr) return fromArr;
  const fromAlt = firstAlternativeText(o);
  if (fromAlt) return fromAlt;
  if (typeof o.partial === "string" && o.partial.trim()) return o.partial.trim();
  return "";
}

function voskPartialText(obj) {
  const o = parseVoskJson(obj);
  if (!o || typeof o !== "object") return "";
  if (typeof o.partial === "string" && o.partial.trim()) return o.partial.trim();
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  const fromAlt = firstAlternativeText(o);
  if (fromAlt) return fromAlt;
  const fromPartialWords = wordsFromResultArray(o.partial_result);
  if (fromPartialWords) return fromPartialWords;
  const fromArr = wordsFromResultArray(o.result);
  if (fromArr) return fromArr;
  return "";
}

module.exports = { parseVoskJson, voskFinalText, voskPartialText };
