// #region agent log
let _dwGlobalFallbackLogTs = 0;
// #endregion

/** Bounded norm-string scan windows — avoids indexOf hot loops over entire long scripts (minutes-long lag). */
const NORM_SCAN_FORWARD_WINDOW = 5200;
const NORM_SCAN_GLOBAL_WINDOW = 24000;

/** Avoid O(scriptLen) re-normalize on every Vosk frame; invalidate when `script` identity changes. */
let _normScriptKey: string | null = null;
let _normScriptWithSpaces = "";
let _normScriptCompact = "";

function normScriptSlices(script: string, ignoreSpaces: boolean): string {
  if (_normScriptKey !== script) {
    _normScriptKey = script;
    _normScriptWithSpaces = normalizeForSpeechMatch(script);
    _normScriptCompact = _normScriptWithSpaces.replace(/ /g, "");
  }
  return ignoreSpaces ? _normScriptCompact : _normScriptWithSpaces;
}

/**
 * Log: prevEnd stuck while partials keep coming — recomputing normalize(script.slice(0, prevEnd))
 * every match was O(prevEnd) per frame and choked mid-long-script sessions.
 */
let _prevNormPrefixCache: { script: string; prevEnd: number; compact: boolean; len: number } | null =
  null;

function prevNormPrefixLength(script: string, prevEnd: number, compact: boolean): number {
  const pe = Math.max(0, Math.floor(prevEnd));
  const hit = _prevNormPrefixCache;
  if (hit && hit.script === script && hit.prevEnd === pe && hit.compact === compact) {
    return hit.len;
  }
  const slice = script.slice(0, pe);
  const len = compact
    ? normalizeForSpeechMatch(slice).replace(/ /g, "").length
    : normalizeForSpeechMatch(slice).length;
  _prevNormPrefixCache = { script, prevEnd: pe, compact, len };
  return len;
}

/**
 * Normalize script / speech for loose substring matching (Latin + CJK in one string — 中英夹杂 OK).
 */
export function normalizeForSpeechMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff ]/gi, "")
    .trim();
}

/** True when script has both CJK and Latin letters (中英夹杂). Used to relax follow matching. */
export function scriptHasMixedZhEn(script: string): boolean {
  return /[\u4e00-\u9fff]/.test(script) && /[a-zA-Z]/.test(script);
}

/**
 * Advance past a Latin alphanumeric run in **source** markdown (clips, OK, recording…).
 * Skips a small prefix of markdown fluff (spaces, *, _) before the run. Does not skip pure digits
 * without letters (avoids eating "100" in Chinese).
 */
export function scriptSkipLatinAlphanumericRun(script: string, from: number): number {
  const L = script.length;
  let i = Math.max(0, Math.min(Math.floor(from), L));
  const maxJunk = 10;
  let junk = 0;
  while (i < L && junk < maxJunk) {
    const ch = script.charCodeAt(i);
    if (ch >= 0x41 && ch <= 0x5a) break;
    if (ch >= 0x61 && ch <= 0x7a) break;
    if (ch >= 0x30 && ch <= 0x39) {
      let j = i;
      while (j < L && script.charCodeAt(j) >= 0x30 && script.charCodeAt(j) <= 0x39) j++;
      const digitSlice = script.slice(i, j);
      if (!/[a-zA-Z]/.test(digitSlice) && (j >= L || !/[a-zA-Z]/.test(script[j]!))) {
        return from;
      }
      break;
    }
    if (ch >= 0x4e00 && ch <= 0x9fff) return from;
    if (ch === 0x20 || ch === 0x09 || ch === 0x2a || ch === 0x5f || ch === 0x60) {
      i++;
      junk++;
      continue;
    }
    return from;
  }
  if (i >= L) return from;
  if (!/[a-zA-Z]/.test(script[i]!)) return from;
  while (i < L && /[a-zA-Z0-9]/.test(script[i]!)) i++;
  return i;
}

/** Smallest script index i such that normalizeForSpeechMatch(script.slice(0, i)).length >= normEnd. */
export function normEndToScriptIndex(script: string, normEnd: number): number {
  if (normEnd <= 0) return 0;
  let lo = 0;
  let hi = script.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const l = normalizeForSpeechMatch(script.slice(0, mid)).length;
    if (l < normEnd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Map “compact” norm length (normalize then remove ASCII spaces) to script index. */
export function normCompactEndToScriptIndex(script: string, compactEnd: number): number {
  if (compactEnd <= 0) return 0;
  const maxC = normScriptSlices(script, true).length;
  if (compactEnd >= maxC) return script.length;
  let lo = 0;
  let hi = script.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const l = normalizeForSpeechMatch(script.slice(0, mid)).replace(/ /g, "").length;
    if (l < compactEnd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Norm-string index at end of script.slice(0, scriptPrefixEnd) — same space model as sn / snC. */
function normIndexAtScriptPrefix(script: string, scriptPrefixEnd: number, compact: boolean): number {
  if (scriptPrefixEnd <= 0) return 0;
  const slice = script.slice(0, Math.min(scriptPrefixEnd, script.length));
  if (compact) return normalizeForSpeechMatch(slice).replace(/ /g, "").length;
  return normalizeForSpeechMatch(slice).length;
}

export type MatchReadEndOptions = {
  /** Minimum tail length to try (default 2). */
  minTailLen?: number;
  /** Cap how far ahead we move per update, in normalized characters (omit = no cap). */
  maxNormAdvance?: number;
  /** If false, only match from searchStart — avoids jumping to duplicate phrases elsewhere. */
  allowGlobalFallback?: boolean;
  /** Norm chars before anchor to include when scanning (default 80). */
  anchorLookback?: number;
  /**
   * If true, never search for a match starting before `prevNormLen - onlyAheadSlackNorm` in the
   * normalized script. Stops CJK/Latin duplicate phrases *before* the read cursor from winning
   * and dragging the caret down the page on partials.
   */
  onlyMatchAhead?: boolean;
  /** Norm chars of lookback before read head when onlyMatchAhead (default 0). */
  onlyAheadSlackNorm?: number;
  /**
   * If true, for each tail length (longest first), among all occurrences of the fragment that
   * advance the read head, pick the smallest script advance. Reduces “teleport” to a far duplicate
   * when the same phrase repeats in the script (common in Chinese).
   */
  pickNearestMatch?: boolean;
  /** Compare script/spoken after dropping spaces from normalized strings (Zh ASR vs spaced script). */
  matchIgnoreSpaces?: boolean;
  /**
   * Scan all tail lengths and occurrences; pick the smallest script end index (earliest plausible
   * continuation); tie-break longer tail. Helps Zh when a long suffix matches only at a far duplicate.
   */
  preferClosestScriptEnd?: boolean;
  /**
   * When > 0, discard matches whose start in the norm string lies before the norm offset of
   * script index max(0, prevEnd - lookback). Stops long scripts from locking onto early duplicates.
   */
  longScriptMatchLookbackChars?: number;
  /**
   * If no hit with minTailLen, retry once with minTailLen 2 (ad-lib / ASR drift). Only one retry.
   */
  allowLooseTailFallback?: boolean;
};

/**
 * Closest-end scan: best for CJK when duplicates + ASR/script spacing differ.
 */
function matchReadEndPreferClosest(
  script: string,
  spoken: string,
  prevEnd: number,
  options: MatchReadEndOptions
): number {
  const minTailLen = options.minTailLen ?? 2;
  const anchorLookback = options.anchorLookback ?? 80;
  const allowGlobalFallback = options.allowGlobalFallback ?? false;
  const ignoreSpaces = options.matchIgnoreSpaces === true;

  const sn = normScriptSlices(script, ignoreSpaces);
  const tk0 = normalizeForSpeechMatch(spoken);
  const tk = ignoreSpaces ? tk0.replace(/ /g, "") : tk0;
  if (tk.length < minTailLen) return prevEnd;

  const prevWorkLen = prevNormPrefixLength(script, prevEnd, ignoreSpaces);

  /** Log: scoreAt calls same workIdx hundreds of times — each norm*EndToScriptIndex was O(n) bisection. */
  const toScriptMemo = new Map<number, number>();
  const toScript = (workIdx: number) => {
    let v = toScriptMemo.get(workIdx);
    if (v === undefined) {
      v = ignoreSpaces ? normCompactEndToScriptIndex(script, workIdx) : normEndToScriptIndex(script, workIdx);
      toScriptMemo.set(workIdx, v);
    }
    return v;
  };

  const anchor = Math.max(0, prevWorkLen - 40);
  let searchStart = Math.max(0, anchor - anchorLookback);
  if (options.onlyMatchAhead) {
    const slack = options.onlyAheadSlackNorm ?? 0;
    searchStart = Math.max(searchStart, Math.max(0, prevWorkLen - slack));
  }

  const lb = options.longScriptMatchLookbackChars ?? 0;
  const minScriptIdx = lb > 0 ? Math.max(0, prevEnd - Math.floor(lb)) : 0;
  const minNormIdx = lb > 0 ? normIndexAtScriptPrefix(script, minScriptIdx, ignoreSpaces) : 0;
  const boundedSearchStart = Math.max(searchStart, minNormIdx);

  const scoreAt = (idx: number, fragLen: number): number => {
    const end = idx + fragLen;
    let scriptEnd = toScript(end);
    scriptEnd = Math.max(prevEnd, Math.min(scriptEnd, script.length));
    if (options.maxNormAdvance != null) {
      const capW = prevWorkLen + options.maxNormAdvance;
      scriptEnd = Math.min(scriptEnd, toScript(capW));
    }
    return scriptEnd;
  };

  /** Prefer smallest script end (nearest continuation); tie-break longer tail (more ASR context). */
  const scanFrom = (start: number, windowMax: number): { end: number; len: number } => {
    const searchEnd = Math.min(sn.length, start + windowMax);
    let bestEnd = -1;
    let bestLen = -1;
    for (let len = Math.min(tk.length, 220); len >= minTailLen; len--) {
      const frag = tk.slice(-len);
      let pos = start;
      while (pos <= searchEnd) {
        const idx = sn.indexOf(frag, pos);
        if (idx < 0 || idx > searchEnd) break;
        if (idx + frag.length <= prevWorkLen) {
          pos = idx + 1;
          continue;
        }
        const se = scoreAt(idx, frag.length);
        if (se > prevEnd) {
          if (bestEnd < 0 || se < bestEnd || (se === bestEnd && len > bestLen)) {
            bestEnd = se;
            bestLen = len;
          }
        }
        pos = idx + 1;
      }
    }
    return { end: bestEnd, len: bestLen };
  };

  const forward = scanFrom(boundedSearchStart, NORM_SCAN_FORWARD_WINDOW);
  if (forward.end > prevEnd) return forward.end;
  if (allowGlobalFallback) {
    const global = scanFrom(lb > 0 ? minNormIdx : 0, NORM_SCAN_GLOBAL_WINDOW);
    if (global.end > prevEnd) return global.end;
  }
  if (options.allowLooseTailFallback && minTailLen > 2 && tk.length >= 2) {
    return matchReadEndPreferClosest(script, spoken, prevEnd, {
      ...options,
      minTailLen: 2,
      allowLooseTailFallback: false,
    });
  }
  return prevEnd;
}

/**
 * Advance read position in `script` from recognized `spoken` text.
 * Monotonic in `prevEnd` (never moves backward).
 *
 * Unstable ASR partials + `indexOf` on the whole script cause large random jumps; use stricter
 * options for partials (especially CJK) and looser ones for finals.
 */
export function matchReadEnd(
  script: string,
  spoken: string,
  prevEnd: number,
  options?: MatchReadEndOptions
): number {
  if (options?.preferClosestScriptEnd) {
    return matchReadEndPreferClosest(script, spoken, prevEnd, options);
  }

  const minTailLen = options?.minTailLen ?? 2;
  const anchorLookback = options?.anchorLookback ?? 80;
  const allowGlobalFallback = options?.allowGlobalFallback ?? true;

  const sn = normScriptSlices(script, false);
  const tk = normalizeForSpeechMatch(spoken);
  if (tk.length < minTailLen) return prevEnd;

  const prevNormLen = prevNormPrefixLength(script, prevEnd, false);
  const anchor = Math.max(0, prevNormLen - 40);
  let searchStart = Math.max(0, anchor - anchorLookback);
  if (options?.onlyMatchAhead) {
    const slack = options.onlyAheadSlackNorm ?? 0;
    searchStart = Math.max(searchStart, Math.max(0, prevNormLen - slack));
  }

  const lb = options?.longScriptMatchLookbackChars ?? 0;
  const minScriptIdx = lb > 0 ? Math.max(0, prevEnd - Math.floor(lb)) : 0;
  const minNormIdx = lb > 0 ? normIndexAtScriptPrefix(script, minScriptIdx, false) : 0;
  const boundedSearchStart = Math.max(searchStart, minNormIdx);
  const forwardSearchEnd = Math.min(sn.length, boundedSearchStart + NORM_SCAN_FORWARD_WINDOW);
  const globalSearchEnd = Math.min(sn.length, (lb > 0 ? minNormIdx : 0) + NORM_SCAN_GLOBAL_WINDOW);

  const pickNearest = options?.pickNearestMatch === true;

  const normEndMemo = new Map<number, number>();
  const normToScript = (normEnd: number) => {
    let v = normEndMemo.get(normEnd);
    if (v === undefined) {
      v = normEndToScriptIndex(script, normEnd);
      normEndMemo.set(normEnd, v);
    }
    return v;
  };

  const scoreOccurrence = (idx: number, fragLen: number): number => {
    const normEnd = idx + fragLen;
    let scriptEnd = normToScript(normEnd);
    scriptEnd = Math.max(prevEnd, Math.min(scriptEnd, script.length));
    if (options?.maxNormAdvance != null) {
      const capNorm = prevNormLen + options.maxNormAdvance;
      const capScript = normToScript(capNorm);
      scriptEnd = Math.min(scriptEnd, capScript);
    }
    return scriptEnd;
  };

  for (let len = Math.min(tk.length, 220); len >= minTailLen; len--) {
    const frag = tk.slice(-len);
    if (pickNearest) {
      let bestEnd = -1;
      let pos = boundedSearchStart;
      while (pos <= forwardSearchEnd) {
        const idx = sn.indexOf(frag, pos);
        if (idx < 0 || idx > forwardSearchEnd) break;
        if (idx < minNormIdx) {
          pos = idx + 1;
          continue;
        }
        if (idx + frag.length <= prevNormLen) {
          pos = idx + 1;
          continue;
        }
        const scriptEnd = scoreOccurrence(idx, frag.length);
        if (scriptEnd > prevEnd && (bestEnd < 0 || scriptEnd < bestEnd)) bestEnd = scriptEnd;
        pos = idx + 1;
      }
      if (bestEnd > prevEnd) return bestEnd;
      if (allowGlobalFallback) {
        let gpos = lb > 0 ? minNormIdx : 0;
        while (gpos <= globalSearchEnd) {
          const idx = sn.indexOf(frag, gpos);
          if (idx < 0 || idx > globalSearchEnd) break;
          if (idx < minNormIdx) {
            gpos = idx + 1;
            continue;
          }
          if (idx + frag.length <= prevNormLen) {
            gpos = idx + 1;
            continue;
          }
          // #region agent log
          if (typeof fetch !== "undefined") {
            const now = Date.now();
            if (now - _dwGlobalFallbackLogTs > 200) {
              _dwGlobalFallbackLogTs = now;
              fetch("http://127.0.0.1:7279/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e625b6" },
                body: JSON.stringify({
                  sessionId: "e625b6",
                  location: "teleprompterSpeechMatch.ts:matchReadEnd",
                  message: "global fallback match",
                  hypothesisId: "H_B",
                  data: { len, idx, searchStart, prevEnd, fragTail: frag.slice(-24) },
                  timestamp: now,
                }),
              }).catch(() => {});
            }
          }
          // #endregion
          const scriptEnd = scoreOccurrence(idx, frag.length);
          if (scriptEnd > prevEnd && (bestEnd < 0 || scriptEnd < bestEnd)) bestEnd = scriptEnd;
          gpos = idx + 1;
        }
        if (bestEnd > prevEnd) return bestEnd;
      }
      continue;
    }

    let idx = -1;
    {
      const sliceEnd = Math.min(sn.length, forwardSearchEnd + frag.length);
      const local = sn.slice(boundedSearchStart, sliceEnd).indexOf(frag);
      if (local >= 0) idx = boundedSearchStart + local;
    }
    let usedGlobal = false;
    if (idx < 0 && allowGlobalFallback) {
      const g0 = lb > 0 ? minNormIdx : 0;
      const sliceEnd = Math.min(sn.length, globalSearchEnd + frag.length);
      const local = sn.slice(g0, sliceEnd).indexOf(frag);
      if (local >= 0) {
        idx = g0 + local;
        usedGlobal = true;
      }
    }
    if (idx >= 0) {
      // #region agent log
      if (usedGlobal && typeof fetch !== "undefined") {
        const now = Date.now();
        if (now - _dwGlobalFallbackLogTs > 200) {
          _dwGlobalFallbackLogTs = now;
          fetch("http://127.0.0.1:7279/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e625b6" },
            body: JSON.stringify({
              sessionId: "e625b6",
              location: "teleprompterSpeechMatch.ts:matchReadEnd",
              message: "global fallback match",
              hypothesisId: "H_B",
              data: {
                len,
                idx,
                searchStart,
                prevEnd,
                fragTail: frag.slice(-24),
              },
              timestamp: now,
            }),
          }).catch(() => {});
        }
      }
      // #endregion
      const scriptEnd = scoreOccurrence(idx, frag.length);
      if (scriptEnd > prevEnd) return scriptEnd;
    }
  }
  if (options?.allowLooseTailFallback && minTailLen > 2 && tk.length >= 2) {
    return matchReadEnd(script, spoken, prevEnd, {
      ...options,
      minTailLen: 2,
      allowLooseTailFallback: false,
    });
  }
  return prevEnd;
}
