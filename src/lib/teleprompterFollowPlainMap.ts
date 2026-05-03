import { normalizeForSpeechMatch } from "@/lib/teleprompterSpeechMatch";

/** Same norm “key” length model as Zh vs En speech match (compact vs spaced). */
export function normKeyLenForFollow(s: string, lang: "zh" | "en" | "it"): number {
  const n = normalizeForSpeechMatch(s);
  return lang === "zh" ? n.replace(/ /g, "").length : n.length;
}

/**
 * Map Vosk/matcher script character index (into markdown source) → plain-text offset compatible with
 * TipTap `editor.getText()` / ProseMirror `textBetween(..., "\\n\\n", "\\n")`.
 *
 * Linear `(readChars / len) * plain.length` is wrong when markdown syntax and body text don’t align
 * 1:1 with character indices (headings, lists, emphasis).
 */
export function scriptIndexToPlainTextOffset(
  markdown: string,
  readChars: number,
  plainFull: string,
  lang: "zh" | "en" | "it",
): number {
  const capped = Math.max(0, Math.min(Math.floor(readChars), markdown.length));
  const targetNorm = normKeyLenForFollow(markdown.slice(0, capped), lang);
  if (targetNorm <= 0) return 0;
  if (!plainFull.length) return 0;

  let lo = 0;
  let hi = plainFull.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const n = normKeyLenForFollow(plainFull.slice(0, mid), lang);
    if (n <= targetNorm) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Scroll target fraction [0,1]: normalized progress through script (matches speech matcher semantics). */
export function followScrollFraction(
  markdown: string,
  readChars: number,
  lang: "zh" | "en" | "it",
): number {
  const L = markdown.length;
  if (L <= 0) return 0;
  const full = normKeyLenForFollow(markdown, lang);
  if (full <= 0) return Math.min(1, readChars / L);
  const pref = normKeyLenForFollow(markdown.slice(0, Math.min(Math.max(0, readChars), L)), lang);
  return Math.min(1, pref / full);
}

/**
 * Inverse of {@link followScrollFraction} for a given scroll ratio: manual scroll → script index so
 * voice follow continues from the visible passage (same norm model as scroll + matcher).
 */
export function readCharsForFollowScrollFraction(
  markdown: string,
  targetFrac: number,
  lang: "zh" | "en" | "it",
): number {
  const L = markdown.length;
  if (L <= 0) return 0;
  const f = Math.max(0, Math.min(1, targetFrac));
  const full = normKeyLenForFollow(markdown, lang);
  if (full <= 0) {
    return Math.min(L, Math.floor(f * L));
  }
  let lo = 0;
  let hi = L;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (followScrollFraction(markdown, mid, lang) < f) lo = mid + 1;
    else hi = mid;
  }
  const c1 = Math.max(0, lo - 1);
  const c2 = Math.min(L, lo);
  const f1 = followScrollFraction(markdown, c1, lang);
  const f2 = followScrollFraction(markdown, c2, lang);
  if (Math.abs(f1 - f) <= Math.abs(f2 - f)) return c1;
  return c2;
}

/**
 * Largest script index such that {@link scriptIndexToPlainTextOffset} is ≤ plain target (viewport hit).
 * Used when manual scroll maps DOM position → readChars for follow resume.
 */
export function readCharsForPlainTextOffset(
  markdown: string,
  plainTargetOffset: number,
  plainFull: string,
  lang: "zh" | "en" | "it",
): number {
  const L = markdown.length;
  if (L <= 0) return 0;
  if (!plainFull.length) return 0;
  const capped = Math.max(0, Math.min(Math.floor(plainTargetOffset), plainFull.length));

  let lo = 0;
  let hi = L;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const o = scriptIndexToPlainTextOffset(markdown, mid, plainFull, lang);
    if (o <= capped) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
