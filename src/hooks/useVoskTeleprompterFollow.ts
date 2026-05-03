import { useCallback, useEffect, useRef, useState } from "react";
import {
  matchReadEnd,
  normalizeForSpeechMatch,
  scriptHasMixedZhEn,
} from "@/lib/teleprompterSpeechMatch";
import {
  abandonStashedTeleprompterFollowAudioContext,
  takeTeleprompterFollowAudioContext,
} from "@/lib/teleprompterVoiceFollowAudio";
import { startTeleprompterMicPcm16k } from "@/lib/teleprompterMicTo16k";
import { TELEPROMPTER_FOLLOW_LATENCY_PROFILE } from "@/config/featureFlags";

// #region agent log
function dwFollowLog(payload: Record<string, unknown>) {
  fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
    body: JSON.stringify({ sessionId: "dc7a9b", runId: "post-fix-v1", timestamp: Date.now(), ...payload }),
  }).catch(() => {});
}
/** Module-level throttle so debug instrumentation does not add useRef (HMR/hook-order crash vs old bundle). */
let _dwFollowPumpLogTs = 0;
let _dwFollowQueueLogTs = 0;
let _dwZhScriptCapLogTs = 0;
/** Long-session: match cost vs spoken/script length (H1/H2). */
let _dwMatchCostLogTs = 0;
/** Debug session dc7a9b — throttle follow pipeline logs. */
let _dw7306StallTs = 0;
let _dw7306RmsTs = 0;
let _dw7306AdvanceTs = 0;
// #endregion

// #region agent log
/** Debug session 6bad53 — cold path + mixed-script follow (see hypotheses in task). */
function dwDebug6(payload: Record<string, unknown>) {
  fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6bad53" },
    body: JSON.stringify({ sessionId: "6bad53", timestamp: Date.now(), ...payload }),
  }).catch(() => {});
}
let _dw6StallTs = 0;
let _dw6RmsTs = 0;
let _dw6CapTs = 0;
let _dw6Pass2Ts = 0;
let _dw6BlindTs = 0;
let _dw6SkipLatinTs = 0;
// #endregion

/**
 * Only if the read head is **already at** (after whitespace) a Latin token — advance past **that** word.
 * Does **not** scan forward for “next English in the paragraph” (that caused large jumps / 大段吞字).
 */
function skipLatinWordAtCursorOnly(script: string, from: number): number {
  if (from < 0 || from >= script.length) return from;
  let i = from;
  const L = script.length;
  while (i < L && /\s/.test(script[i]!)) i++;
  if (i >= L || !/[A-Za-z]/.test(script[i]!)) return from;
  let j = i;
  while (j < L && /[A-Za-z0-9]/.test(script[j]!)) j++;
  return j;
}

/**
 * Matcher only compares suffixes of normalized spoken (≤220 norm chars in scan); unbounded finals
 * made normalize(spoken) O(session time) and caused mid-session slowdown (~3–4 min).
 */
const SPOKEN_MATCH_TAIL_CHARS = 768;

export type TeleprompterVoskLang = "en" | "zh" | "it";

type VoskFeedResult =
  | { kind: "final"; text: string }
  | { kind: "partial"; partial: string }
  | { kind: "error"; error: string }
  | null;

type VoskElectronApi = {
  voskModelPath?: (lang: TeleprompterVoskLang) => Promise<{ path: string; ok: boolean }>;
  voskInit?: (modelPath: string) => Promise<{ ok: boolean; error?: string }>;
  voskFeed?: (data: Int16Array) => Promise<VoskFeedResult>;
  voskReset?: () => Promise<void>;
  voskRelease?: () => Promise<void>;
};

/** Preload sets `isElectron: true`; some windows/older builds may omit it but still expose vosk IPC. Never treat `isElectron === false` mocks as real. */
function getVoskApi(): VoskElectronApi | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    electronAPI?: VoskElectronApi & { isElectron?: boolean };
  };
  const api = w.electronAPI;
  if (!api?.voskInit || !api?.voskFeed) return null;
  if (api.isElectron === false) return null;
  return api;
}

function mergeInt16(a: Int16Array, b: Int16Array): Int16Array {
  const o = new Int16Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

function mergeInt16Many(chunks: Int16Array[]): Int16Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const o = new Int16Array(n);
  let off = 0;
  for (const c of chunks) {
    o.set(c, off);
    off += c.length;
  }
  return o;
}

/** RMS ~0.001–0.003 silence, ~0.02+ speech @ 16-bit PCM. */
function pcmChunkRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! / 32768;
    s += v * v;
  }
  return Math.sqrt(s / pcm.length);
}

/** Merged IPC batches dilute RMS vs speech peaks — gate on loudest slice (fast talk + backlog). */
function pcmChunkRmsMaxFromBatch(parts: Int16Array[]): number {
  if (parts.length === 0) return 0;
  let m = 0;
  for (const p of parts) m = Math.max(m, pcmChunkRms(p));
  return m;
}

/** Below this RMS, partial-driven advances are skipped — higher = more locked to actual speech energy. */
const SILENCE_RMS_BELOW = 0.00455;
/** Finals must have measurable PCM energy (avoid grey advancing on silence / queue drain). */
const SILENCE_RMS_FINAL_MIN = 0.00185;

/** Longer warm window + lower floor: syllables ~0.004–0.006 RMS; keep warm slightly below cold. */
const SILENCE_RMS_WARM_MS = 4200;
const SILENCE_RMS_WARM_PARTIAL = 0.00345;

/**
 * When ASR norm clearly moves, allow modest floor relax — but not as low as before (was racing ahead of speaker).
 */
const SILENCE_RMS_ZH_PARTIAL_BUSY = 0.00355;
const SILENCE_RMS_ZH_MATCH_RELAX = 0.00295;
const SILENCE_RMS_ZH_MATCH_RELAX_STRONG = 0.00255;
/** En partials: when ASR norm length clearly moved, relax floor (symmetric to zh busy path). */
const SILENCE_RMS_EN_PARTIAL_BUSY = 0.00285;

/** Per-IPC script char cap (Zh partials). Tighter = karaoke follows mouth, not ASR lookahead. */
const ZH_PARTIAL_STEP_MAX = 3;
const ZH_PARTIAL_STEP_MAX_QUEUE = 4;
/** Mixed zh/en: smaller steps reduce burst 吞字 when matcher jumps. */
const ZH_MIX_PARTIAL_STEP_MAX = 6;
const ZH_MIX_PARTIAL_STEP_MAX_QUEUE = 7;
/** Matcher already advances far ahead of read head — force catch-up caps (script indices). */
const ZH_MATCHGAP_CATCHUP_MIN = 22;
const ZH_MATCHGAP_CATCHUP_MIN_MIX = 26;
/** When ASR norm runs ahead of read head (queue + normDelta), allow larger steps — bounded below. */
const ZH_CATCHUP_PARTIAL_MAX = 22;
const ZH_CATCHUP_PARTIAL_MAX_QUEUE = 28;
const ZH_CATCHUP_MIX_PARTIAL_MAX = 26;
const ZH_CATCHUP_MIX_PARTIAL_MAX_QUEUE = 32;
/** Min norm delta + queue depth to treat as sustained catch-up (reduces long-session drift). */
const ZH_CATCHUP_NORM_DELTA_QUEUE = 5;
const ZH_CATCHUP_QUEUE_MIN = 7;
/** Strong catch-up: ASR clearly moved even if queue is modest. */
const ZH_CATCHUP_NORM_DELTA_STRONG = 8;

/** ~6ms @ 16kHz — slightly higher feed cadence vs 128 (lower end-to-end ASR latency). */
const CHUNK_SAMPLES = 96;
/** Max samples per IPC (~94ms @ 16kHz). */
const FEED_BATCH_MAX_SAMPLES = 1500;
const FEED_BATCH_MAX_SAMPLES_DRAIN = 2800;
/** First voskFeed only: small batch so partials start before a full ~100ms block is buffered. */
const FEED_FIRST_BATCH_MAX_SAMPLES = 192;
/** Fast speech fills the PCM queue; draining it in one pump() starves React/scroll and bursts readChars. */
const PUMP_MAX_FEEDS_PER_TURN = 17;
/** Base cap on readChars updates per pump slice; adaptive boost when PCM queue backs up (fast speech). */
const PUMP_MAX_ADVANCES_BASE = 11;

/**
 * Offline Vosk in the main process + mic capture in the renderer.
 * When `active` is false, stops the mic and resets Vosk (model stays loaded in main).
 */
export function useVoskTeleprompterFollow(opts: {
  active: boolean;
  script: string;
  lang: TeleprompterVoskLang;
  resetSignal: number;
}): {
  readChars: number;
  error: string | null;
  status: string;
  applyScriptReadAnchor: (scriptCharIndex: number, opts?: { allowBackward?: boolean }) => void;
} {
  const [readChars, setReadChars] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const finalsRef = useRef("");
  const readEndRef = useRef(0);
  const scriptRef = useRef(opts.script);
  /** Skip rematching when Vosk returns identical partial/final text (stops silent “crawl”). */
  const lastVoskDigestRef = useRef("");
  /** Norm length of `spoken` last time we advanced readEnd — partial+RMS gate otherwise lags across word gaps. */
  const lastAdvanceNormKeyLenRef = useRef(0);
  /** Latest compact/spoken norm len from last Vosk frame (manual seek uses min with script prefix). */
  const lastSeenNormKeyLenRef = useRef(0);
  const applyScriptReadAnchorRef = useRef<(n: number, anchorOpts?: { allowBackward?: boolean }) => void>(
    () => {},
  );
  /** Only reset follow position when resetSignal increases (panel reset), not when it drops from stale IPC. */
  const lastResetSignalRef = useRef<number | null>(null);
  scriptRef.current = opts.script;

  useEffect(() => {
    if (lastResetSignalRef.current === null) {
      lastResetSignalRef.current = opts.resetSignal;
      const api = getVoskApi();
      if (api?.voskReset) void api.voskReset();
      return;
    }
    if (opts.resetSignal <= lastResetSignalRef.current) return;
    lastResetSignalRef.current = opts.resetSignal;
    readEndRef.current = 0;
    setReadChars(0);
    finalsRef.current = "";
    lastVoskDigestRef.current = "";
    lastAdvanceNormKeyLenRef.current = 0;
    const api = getVoskApi();
    if (api?.voskReset) void api.voskReset();
  }, [opts.resetSignal]);

  useEffect(() => {
    const L = opts.script.length;
    readEndRef.current = Math.min(readEndRef.current, L);
    setReadChars((c) => Math.min(c, L));
  }, [opts.script.length]);

  useEffect(() => {
    if (!opts.active) {
      applyScriptReadAnchorRef.current = () => {};
      setError(null);
      setStatus("");
      abandonStashedTeleprompterFollowAudioContext();
      /* Do not voskReset here — next init() awaits reset on cache hit; avoids racing worker and forced reload. */
      return;
    }

    const api = getVoskApi();
    if (!api) {
      // #region agent log
      fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
        body: JSON.stringify({
          sessionId: "dc7a9b",
          location: "useVoskTeleprompterFollow.ts:noApi",
          message: "vosk electron api missing",
          hypothesisId: "H5",
          data: { branch: "no_api" },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      setError("Voice follow requires the desktop app (Electron).");
      return;
    }

    setError(null);
    setStatus("Loading speech model…");
    lastVoskDigestRef.current = "";
    lastAdvanceNormKeyLenRef.current = 0;
    lastSeenNormKeyLenRef.current = 0;

    let cancelled = false;
    applyScriptReadAnchorRef.current = (charIndex: number, anchorOpts?: { allowBackward?: boolean }) => {
      if (cancelled) return;
      const s = scriptRef.current;
      const L = s.length;
      const c = Math.max(0, Math.min(Math.floor(charIndex), L));
      /* Scroll-derived anchors must not rewind voice match unless user explicitly scrolled up (Teleprompter passes allowBackward). */
      if (!anchorOpts?.allowBackward && c < readEndRef.current) {
        return;
      }
      readEndRef.current = c;
      lastVoskDigestRef.current = "";
      const at =
        opts.lang === "zh"
          ? normalizeForSpeechMatch(s.slice(0, c)).replace(/ /g, "").length
          : normalizeForSpeechMatch(s.slice(0, c)).length;
      lastAdvanceNormKeyLenRef.current = Math.min(lastSeenNormKeyLenRef.current, at);
      setReadChars(c);
    };
    const ctxRef = { current: null as AudioContext | null };
    ctxRef.current = takeTeleprompterFollowAudioContext();
    let stopMicCapture: (() => void) | null = null;
    let mediaStream: MediaStream | null = null;
    const ipcErrRef = { current: false };
    const queue: Int16Array[] = [];
    let feeding = false;
    let pendingPcm = new Int16Array(0);
    let micStartedAtMs = 0;
    let voskFirstFeedPending = true;
    const followLatencyProf = TELEPROMPTER_FOLLOW_LATENCY_PROFILE
      ? {
          lastAdvanceMs: 0,
          lastLogMs: 0,
          feedSumMs: 0,
          feedCount: 0,
        }
      : null;
    const matchOptsFor = (kind: "final" | "partial", spoken: string, finalChunk?: string) => {
      const nlen = normalizeForSpeechMatch(spoken).length;
      const mixedScript = scriptHasMixedZhEn(scriptRef.current);
      if (kind === "final") {
        /* Full `spoken` includes all finals — using it blew maxNormAdvance to 360 (log: delta 982 @ spokenLen 39). Cap from THIS final only. */
        const inc = Math.max(1, normalizeForSpeechMatch(finalChunk ?? "").length);
        if (opts.lang === "zh") {
          /* Zh: ignore script/ASR space mismatch; closest script advance beats far duplicate of long tail. */
          return {
            minTailLen: inc <= 6 ? Math.max(2, inc) : 3,
            allowGlobalFallback: false as const,
            /* Finals can still map to many script chars; pair with per-update script cap in pump. */
            maxNormAdvance: Math.min(20, Math.max(8, inc * 2)),
            anchorLookback: 120,
            onlyMatchAhead: true as const,
            onlyAheadSlackNorm: mixedScript ? 12 : 8,
            matchIgnoreSpaces: true as const,
            preferClosestScriptEnd: true as const,
            longScriptMatchLookbackChars: 640,
            allowLooseTailFallback: true as const,
          };
        }
        const maxNormAdvance = Math.min(128, Math.max(24, inc * 12));
        const minTailLen = inc <= 8 ? Math.max(2, inc) : 2;
        return { minTailLen, allowGlobalFallback: true as const, maxNormAdvance };
      }
      /* Partials: short tails repeat in script; onlyMatchAhead avoids matching earlier duplicates (esp. CJK). */
      if (opts.lang === "zh") {
        return {
          minTailLen: 3,
          maxNormAdvance: Math.min(18, Math.max(7, Math.floor(nlen * 1.08))),
          allowGlobalFallback: false as const,
          anchorLookback: 100,
          onlyMatchAhead: true as const,
          /* Wider slack on 中英夹杂: CJK↔Latin boundary shifts norm anchor vs spaced script. */
          onlyAheadSlackNorm: mixedScript ? 14 : 10,
          matchIgnoreSpaces: true as const,
          preferClosestScriptEnd: true as const,
          longScriptMatchLookbackChars: 680,
          allowLooseTailFallback: true as const,
        };
      }
      /* EN/IT: short English tails + minTail 6 used to stall on mixed scripts; relax when Latin+CJK both present. */
      if (mixedScript) {
        return {
          minTailLen: 4,
          maxNormAdvance: Math.min(36, Math.max(12, Math.floor(nlen * 3))),
          allowGlobalFallback: false as const,
          anchorLookback: 140,
          onlyMatchAhead: true as const,
          onlyAheadSlackNorm: 10,
          pickNearestMatch: true as const,
          allowLooseTailFallback: true as const,
        };
      }
      return {
        minTailLen: 6,
        maxNormAdvance: Math.min(36, Math.max(12, Math.floor(nlen * 3))),
        allowGlobalFallback: false as const,
        anchorLookback: 140,
        onlyMatchAhead: true as const,
        onlyAheadSlackNorm: 6,
        pickNearestMatch: true as const,
        allowLooseTailFallback: true as const,
      };
    };

    const pump = async () => {
      if (feeding || cancelled) return;
      feeding = true;
      let feedsThisTurn = 0;
      let advancesThisTurn = 0;
      const queueAtPumpStart = queue.length;
      const maxAdvancesThisPump = Math.min(
        20,
        PUMP_MAX_ADVANCES_BASE + Math.min(10, Math.floor(queueAtPumpStart / 2)),
      );
      try {
      while (queue.length > 0 && !cancelled) {
        if (feedsThisTurn >= PUMP_MAX_FEEDS_PER_TURN) break;
        if (advancesThisTurn >= maxAdvancesThisPump) break;
        const queueLenBeforeFeed = queue.length;
        // #region agent log
        if (queue.length > 24) {
          const nq = Date.now();
          if (nq - _dwFollowQueueLogTs > 400) {
            _dwFollowQueueLogTs = nq;
            dwFollowLog({
              location: "useVoskTeleprompterFollow.ts:pump",
              message: "pcm queue backlog",
              hypothesisId: "H_E",
              data: { queueLen: queue.length },
            });
          }
        }
        // #endregion
        const batch: Int16Array[] = [];
        let batchSamples = 0;
        const batchCap = voskFirstFeedPending
          ? FEED_FIRST_BATCH_MAX_SAMPLES
          : queueLenBeforeFeed > 12
            ? FEED_BATCH_MAX_SAMPLES_DRAIN
            : FEED_BATCH_MAX_SAMPLES;
        while (queue.length > 0 && batchSamples < batchCap) {
          const next = queue.shift()!;
          batch.push(next);
          batchSamples += next.length;
        }
        const chunk = batch.length === 1 ? batch[0]! : mergeInt16Many(batch);
        try {
          const tFeed0 = typeof performance !== "undefined" ? performance.now() : 0;
          const r = await api.voskFeed!(chunk);
          if (followLatencyProf) {
            followLatencyProf.feedSumMs +=
              (typeof performance !== "undefined" ? performance.now() : Date.now()) - tFeed0;
            followLatencyProf.feedCount += 1;
          }
          feedsThisTurn += 1;
          voskFirstFeedPending = false;
          if (!r || cancelled) continue;
          if (r.kind === "error") {
            if (!ipcErrRef.current) {
              ipcErrRef.current = true;
              setError(r.error);
            }
            continue;
          }
          if (r.kind === "final" && r.text) finalsRef.current += `${r.text} `;
          const partial = r.kind === "partial" ? r.partial : "";
          const spokenFull = `${finalsRef.current}${partial}`.trim();
          if (spokenFull.length < 2) continue;
          const kind: "final" | "partial" = r.kind === "final" ? "final" : "partial";
          const spokenNorm = normalizeForSpeechMatch(spokenFull);
          const normKeyLen =
            opts.lang === "zh" ? spokenNorm.replace(/ /g, "").length : spokenNorm.length;
          lastSeenNormKeyLenRef.current = normKeyLen;
          const digest =
            opts.lang === "zh" ? `${kind}|${spokenNorm.replace(/ /g, "")}` : `${kind}|${spokenFull}`;
          if (digest === lastVoskDigestRef.current) {
            continue;
          }

          const spokenForMatch =
            spokenFull.length > SPOKEN_MATCH_TAIL_CHARS
              ? spokenFull.slice(-SPOKEN_MATCH_TAIL_CHARS)
              : spokenFull;
          const matchOpts = matchOptsFor(kind, spokenFull, r.kind === "final" ? r.text : undefined);
          const prevEnd = readEndRef.current;
          // #region agent log
          const matchT0 = typeof performance !== "undefined" ? performance.now() : 0;
          // #endregion
          const firstPassNext = matchReadEnd(scriptRef.current, spokenForMatch, prevEnd, matchOpts);
          let next = firstPassNext;
          /* Mixed 中英: EN/IT matcher ignores spaces in script vs ASR; second pass fixes stalls at Latin segments. */
          if (
            next <= prevEnd &&
            opts.lang !== "zh" &&
            kind === "partial" &&
            scriptHasMixedZhEn(scriptRef.current)
          ) {
            const nm = spokenNorm.length;
            next = matchReadEnd(scriptRef.current, spokenForMatch, prevEnd, {
              minTailLen: 3,
              maxNormAdvance: Math.min(32, Math.max(14, Math.floor(nm * 3))),
              allowGlobalFallback: false,
              anchorLookback: 140,
              onlyMatchAhead: true,
              onlyAheadSlackNorm: 12,
              matchIgnoreSpaces: true,
              preferClosestScriptEnd: true,
              longScriptMatchLookbackChars: 720,
              allowLooseTailFallback: true,
            });
            // #region agent log
            if (next > firstPassNext) {
              const tP2 = Date.now();
              if (tP2 - _dw6Pass2Ts > 350) {
                _dw6Pass2Ts = tP2;
                dwDebug6({
                  hypothesisId: "H_MIX_PASS2",
                  location: "useVoskTeleprompterFollow.ts:pump",
                  message: "mixed-script second matcher pass advanced",
                  data: {
                    firstPassNext,
                    next,
                    prevEnd,
                    lang: opts.lang,
                  },
                });
              }
            }
            // #endregion
          }
          /*
           * zh 模型 + 中英夹杂: 第一遍在 Markdown/ASR 错字、边界处易 stall（log: H_MIX_MATCH）；此前仅 en 模型走第二遍。
           * 第二遍：更短尾、更大 onlyAheadSlackNorm / maxNormAdvance，便于从「最近脚本位置」续上。
           */
          if (
            next <= prevEnd &&
            opts.lang === "zh" &&
            kind === "partial" &&
            scriptHasMixedZhEn(scriptRef.current)
          ) {
            const nm = spokenNorm.length;
            const secondZhMixed = matchReadEnd(scriptRef.current, spokenForMatch, prevEnd, {
              minTailLen: 2,
              maxNormAdvance: Math.min(44, Math.max(18, Math.floor(nm * 2))),
              allowGlobalFallback: false,
              anchorLookback: 160,
              onlyMatchAhead: true,
              onlyAheadSlackNorm: 22,
              matchIgnoreSpaces: true,
              preferClosestScriptEnd: true,
              longScriptMatchLookbackChars: 720,
              allowLooseTailFallback: true,
            });
            if (secondZhMixed > next) {
              next = secondZhMixed;
              const tP2 = Date.now();
              if (tP2 - _dw6Pass2Ts > 350) {
                _dw6Pass2Ts = tP2;
                dwDebug6({
                  hypothesisId: "H_MIX_PASS2",
                  location: "useVoskTeleprompterFollow.ts:pump",
                  message: "zh mixed second matcher pass advanced",
                  fixVersion: "v4",
                  data: {
                    firstPassNext,
                    next,
                    prevEnd,
                    lang: opts.lang,
                  },
                });
              }
            }
          }
          // #region agent log
          const matchMs =
            typeof performance !== "undefined" ? performance.now() - matchT0 : 0;
          const costNt = Date.now();
          if (
            matchMs >= 5 ||
            (costNt - _dwMatchCostLogTs > 2500 && prevEnd > 1200)
          ) {
            _dwMatchCostLogTs = costNt;
            dwFollowLog({
              location: "useVoskTeleprompterFollow.ts:pump",
              message: "matchReadEnd cost",
              hypothesisId: "H1_H2",
              data: {
                matchMs: Math.round(matchMs * 100) / 100,
                prevEnd,
                spokenFullLen: spokenFull.length,
                spokenMatchLen: spokenForMatch.length,
                scriptLen: scriptRef.current.length,
                qRem: queue.length,
              },
            });
          }
          // #endregion
          /* Matcher should be monotonic; en/it mixed paths + edge tails still defensively clamp (digits/CJK/Latin boundaries). */
          if (next < prevEnd) {
            next = prevEnd;
          }
          const mixedZh = scriptHasMixedZhEn(scriptRef.current);
          const ndMove = Math.max(0, normKeyLen - lastAdvanceNormKeyLenRef.current);
          /*
           * 仅当读头**已经落在**拉丁词上（空格后第一个字符是 A–Z）时，跳过**这一个**词。
           * 不在全文 remainder 里找「下一个英文」——避免一次跳几十字、破坏跟读节奏。
           */
          if (
            opts.lang === "zh" &&
            kind === "partial" &&
            next <= prevEnd &&
            mixedZh &&
            ndMove >= 5
          ) {
            const scr = scriptRef.current;
            const afterLatin = skipLatinWordAtCursorOnly(scr, prevEnd);
            if (afterLatin > prevEnd) {
              next = afterLatin;
              const tL = Date.now();
              if (tL - _dw6SkipLatinTs > 700) {
                _dw6SkipLatinTs = tL;
                dwDebug6({
                  hypothesisId: "H_MIX_SKIP_LATIN",
                  location: "useVoskTeleprompterFollow.ts:pump",
                  message: "skipped Latin token at cursor only (zh mixed)",
                  fixVersion: "v3",
                  data: {
                    prevEnd,
                    next,
                    ndMove,
                    skippedSnippet: scr.slice(prevEnd, Math.min(scr.length, afterLatin + 1)),
                  },
                });
              }
            }
          }
          /* 中英夹杂: matcher 卡住且识别仍在动 — 小幅蠕进；阈值与步长保守，避免吞段。 */
          if (
            opts.lang === "zh" &&
            kind === "partial" &&
            next <= prevEnd &&
            mixedZh
          ) {
            const ndBlind = Math.max(0, normKeyLen - lastAdvanceNormKeyLenRef.current);
            if (ndBlind >= 9) {
              const creep = Math.min(3, Math.max(1, Math.floor(ndBlind * 0.14)));
              next = Math.min(scriptRef.current.length, prevEnd + creep);
              // #region agent log
              const tB = Date.now();
              if (tB - _dw6BlindTs > 400) {
                _dw6BlindTs = tB;
                dwDebug6({
                  hypothesisId: "H_MIX_BLIND",
                  location: "useVoskTeleprompterFollow.ts:pump",
                  message: "zh mixed norm-delta blind creep",
                  fixVersion: "v3",
                  data: { prevEnd, next, ndBlind, creep },
                });
              }
              // #endregion
            }
          }
          /* Norm caps ≠ script indices; one Vosk frame can still jump several lines of CJK. Hard script caps per IPC. */
          if (opts.lang === "zh" && next > prevEnd) {
            const matchGap = next - prevEnd;
            const normDeltaForCap = Math.max(0, normKeyLen - lastAdvanceNormKeyLenRef.current);
            const scriptLen = scriptRef.current.length;
            const deepInScript =
              scriptLen > 200 && prevEnd > Math.max(400, Math.floor(scriptLen * 0.07));
            const pastEarlyScript = scriptLen > 0 && prevEnd > Math.floor(scriptLen * 0.08);
            const matchGapCatchUp =
              kind === "partial" &&
              matchGap >= (mixedZh ? ZH_MATCHGAP_CATCHUP_MIN_MIX : ZH_MATCHGAP_CATCHUP_MIN);
            const zhCatchUp =
              kind === "partial" &&
              (matchGapCatchUp ||
                normDeltaForCap >= ZH_CATCHUP_NORM_DELTA_STRONG ||
                (normDeltaForCap >= ZH_CATCHUP_NORM_DELTA_QUEUE && queueLenBeforeFeed >= ZH_CATCHUP_QUEUE_MIN) ||
                (queueLenBeforeFeed >= 16 && normDeltaForCap >= 5) ||
                (queueLenBeforeFeed >= 12 && normDeltaForCap >= 4) ||
                (deepInScript && normDeltaForCap >= 3) ||
                (pastEarlyScript && normDeltaForCap >= 3));
            let partialCapMax: number;
            if (kind === "partial") {
              if (zhCatchUp) {
                const qBig = queueLenBeforeFeed >= 6;
                partialCapMax = mixedZh
                  ? qBig
                    ? ZH_CATCHUP_MIX_PARTIAL_MAX_QUEUE
                    : ZH_CATCHUP_MIX_PARTIAL_MAX
                  : qBig
                    ? ZH_CATCHUP_PARTIAL_MAX_QUEUE
                    : ZH_CATCHUP_PARTIAL_MAX;
              } else {
                partialCapMax = queueLenBeforeFeed >= 6
                  ? mixedZh
                    ? ZH_MIX_PARTIAL_STEP_MAX_QUEUE
                    : ZH_PARTIAL_STEP_MAX_QUEUE
                  : mixedZh
                    ? ZH_MIX_PARTIAL_STEP_MAX
                    : ZH_PARTIAL_STEP_MAX;
              }
            } else {
              partialCapMax = ZH_PARTIAL_STEP_MAX;
            }
            /* Partial: tie to normDelta; floor 3 avoids log’s normDelta 1 → cap 2 “crawl”; matchGap/queue boosts drain backlog without single +8 rows. */
            let scriptCap: number;
            if (kind === "partial") {
              const normDelta = normDeltaForCap;
              const normT = zhCatchUp ? 0.68 : mixedZh ? 0.46 : 0.52;
              /* Tie cap to normDelta; catch-up uses higher coeff + ceiling so read head tracks fast speech. */
              scriptCap = Math.min(partialCapMax, Math.max(2, Math.round(normDelta * normT) + 1));
              if (zhCatchUp) {
                scriptCap = Math.min(
                  partialCapMax,
                  Math.max(scriptCap, Math.min(partialCapMax, Math.round(normDelta * 0.82) + 2)),
                );
              }
              if (prevEnd < 120 && normDelta >= 5) scriptCap = Math.min(partialCapMax, scriptCap + 1);
              if (matchGap > 18 && normDelta >= 3) {
                scriptCap = Math.min(partialCapMax, scriptCap + 1);
              }
              if (matchGap > 28 && normDelta >= 2) {
                scriptCap = Math.min(partialCapMax, scriptCap + 1);
              }
              if (queueLenBeforeFeed > 14) scriptCap = Math.min(partialCapMax, scriptCap + 1);
            } else {
              const finInc = Math.max(
                1,
                normalizeForSpeechMatch(r.kind === "final" ? r.text ?? "" : "")
                  .replace(/ /g, "")
                  .length,
              );
              scriptCap = Math.min(6, Math.max(2, finInc + 1));
            }
            if (next - prevEnd > scriptCap) {
              // #region agent log
              const capNt = Date.now();
              if (capNt - _dwZhScriptCapLogTs > 350) {
                _dwZhScriptCapLogTs = capNt;
                dwFollowLog({
                  location: "useVoskTeleprompterFollow.ts:pump",
                  message: "zh script step cap",
                  hypothesisId: "H_zh_script_cap",
                  data: {
                    kind,
                    prevEnd,
                    matchNext: next,
                    matchGap,
                    queueLenBeforeFeed,
                    cappedTo: prevEnd + scriptCap,
                    scriptCap,
                    normKeyLen,
                    normDelta:
                      kind === "partial"
                        ? Math.max(0, normKeyLen - lastAdvanceNormKeyLenRef.current)
                        : undefined,
                  },
                });
              }
              if (capNt - _dw6CapTs > 400) {
                _dw6CapTs = capNt;
                dwDebug6({
                  hypothesisId: "H_MIX_CAP",
                  location: "useVoskTeleprompterFollow.ts:pump",
                  message: "zh script step cap applied",
                  fixVersion: "v1",
                  data: {
                    prevEnd,
                    matchNextBeforeCap: next,
                    cappedTo: prevEnd + scriptCap,
                    scriptCap,
                    partialCapMax,
                    mixedScript: scriptHasMixedZhEn(scriptRef.current),
                  },
                });
              }
              // #endregion
              next = prevEnd + scriptCap;
            }
          }
          if (next <= prevEnd) {
            lastVoskDigestRef.current = digest;
            // #region agent log
            const tStall = Date.now();
            if (tStall - _dw7306StallTs > 450) {
              _dw7306StallTs = tStall;
              fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
                body: JSON.stringify({
                  sessionId: "dc7a9b",
                  location: "useVoskTeleprompterFollow.ts:matchStall",
                  message: "matchReadEnd did not advance readEnd",
                  hypothesisId: "F1",
                  data: {
                    kind,
                    prevEnd,
                    next,
                    lang: opts.lang,
                    spokenTail: spokenFull.slice(-48),
                  },
                  timestamp: tStall,
                }),
              }).catch(() => {});
            }
            if (tStall - _dw6StallTs > 400) {
              _dw6StallTs = tStall;
              const scr = scriptRef.current;
              const w0 = Math.max(0, prevEnd - 40);
              const w1 = Math.min(scr.length, prevEnd + 100);
              const win = scr.slice(w0, w1);
              dwDebug6({
                hypothesisId: "H_MIX_MATCH",
                location: "useVoskTeleprompterFollow.ts:pump",
                message: "readEnd did not advance — matcher stall",
                data: {
                  kind,
                  prevEnd,
                  next,
                  lang: opts.lang,
                  mixedScript: scriptHasMixedZhEn(scr),
                  scriptWindowLatin: /[a-zA-Z]/.test(win),
                  scriptWindow: win.slice(0, 120),
                  spokenNormTail: spokenNorm.slice(-56),
                  spokenTail: spokenFull.slice(-48),
                },
              });
            }
            // #endregion
            continue;
          }
          const zhNormDeltaForGate =
            opts.lang === "zh" && kind === "partial"
              ? Math.max(0, normKeyLen - lastAdvanceNormKeyLenRef.current)
              : 0;
          const enNormDeltaForGate =
            opts.lang !== "zh" && kind === "partial"
              ? Math.max(0, normKeyLen - lastAdvanceNormKeyLenRef.current)
              : 0;
          const rms =
            batch.length > 1 ? pcmChunkRmsMaxFromBatch(batch) : pcmChunkRms(chunk);
          const warm =
            micStartedAtMs > 0 && Date.now() - micStartedAtMs < SILENCE_RMS_WARM_MS;
          let rmsFloor =
            kind === "final" ? SILENCE_RMS_BELOW : warm ? SILENCE_RMS_WARM_PARTIAL : SILENCE_RMS_BELOW;
          if (kind === "partial" && opts.lang === "zh" && zhNormDeltaForGate >= 3) {
            rmsFloor = Math.min(rmsFloor, SILENCE_RMS_ZH_PARTIAL_BUSY);
          }
          if (kind === "partial" && opts.lang === "zh" && queueLenBeforeFeed > 18) {
            rmsFloor = Math.min(rmsFloor, SILENCE_RMS_WARM_PARTIAL);
          }
          if (kind === "partial" && opts.lang === "zh" && next > prevEnd && zhNormDeltaForGate >= 4) {
            rmsFloor = Math.min(rmsFloor, SILENCE_RMS_ZH_MATCH_RELAX);
          }
          if (kind === "partial" && opts.lang === "zh" && next > prevEnd && zhNormDeltaForGate >= 7) {
            rmsFloor = Math.min(rmsFloor, SILENCE_RMS_ZH_MATCH_RELAX_STRONG);
          }
          if (
            kind === "partial" &&
            opts.lang === "zh" &&
            mixedZh &&
            queueLenBeforeFeed > 20 &&
            zhNormDeltaForGate >= 5
          ) {
            rmsFloor = Math.min(rmsFloor, SILENCE_RMS_ZH_MATCH_RELAX_STRONG);
          }
          if (kind === "partial" && opts.lang !== "zh" && enNormDeltaForGate >= 2) {
            rmsFloor = Math.min(rmsFloor, SILENCE_RMS_WARM_PARTIAL);
          }
          if (kind === "partial" && opts.lang !== "zh" && enNormDeltaForGate >= 5) {
            rmsFloor = Math.min(rmsFloor, SILENCE_RMS_EN_PARTIAL_BUSY);
          }
          /*
           * Partials MUST pass the RMS gate: the old bypass `(partial && next > prevEnd)` let Vosk
           * refine hypotheses during silence and still advance readEnd (log: matchStall then delta 9).
           * Finals still advance (end-of-utterance) — they reflect completed speech, not live noise.
           * Narrow zh path: Vosk norm key can advance while the PCM slice is inter-word silence
           * (rms below cold floor in logs, e.g. zhNormDelta 10); cap step size so we do not reopen
           * the old "partial advances on silence" failure mode.
           */
          const zhMicroQueueCap = mixedZh ? 12 : 6;
          const zhMicroRmsPartial =
            kind === "partial" &&
            opts.lang === "zh" &&
            zhNormDeltaForGate >= 2 &&
            zhNormDeltaForGate <= 8 &&
            queueLenBeforeFeed <= zhMicroQueueCap &&
            next > prevEnd &&
            next - prevEnd <= 5 &&
            rms > 0.00115;
          const allowAdvance =
            (kind === "final" ? rms >= SILENCE_RMS_FINAL_MIN : rms >= rmsFloor) || zhMicroRmsPartial;
          if (!allowAdvance) {
            // #region agent log
            const tRms = Date.now();
            if (tRms - _dw7306RmsTs > 280) {
              _dw7306RmsTs = tRms;
              fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
                body: JSON.stringify({
                  sessionId: "dc7a9b",
                  location: "useVoskTeleprompterFollow.ts:rmsGate",
                  message: "partial advance blocked by RMS floor",
                  hypothesisId: "F2",
                  data: {
                    rms: Math.round(rms * 100000) / 100000,
                    rmsFloor: Math.round(rmsFloor * 100000) / 100000,
                    prevEnd,
                    next,
                    blockedDespiteMatch: kind === "partial" && next > prevEnd,
                    enNormDelta: enNormDeltaForGate || undefined,
                    zhNormDelta: zhNormDeltaForGate || undefined,
                  },
                  timestamp: tRms,
                }),
              }).catch(() => {});
            }
            if (tRms - _dw6RmsTs > 320) {
              _dw6RmsTs = tRms;
              dwDebug6({
                hypothesisId: "H_MIX_RMS",
                location: "useVoskTeleprompterFollow.ts:pump",
                message: "partial advance blocked by RMS floor",
                data: {
                  rms: Math.round(rms * 100000) / 100000,
                  rmsFloor: Math.round(rmsFloor * 100000) / 100000,
                  prevEnd,
                  next,
                  kind,
                  lang: opts.lang,
                  mixedScript: scriptHasMixedZhEn(scriptRef.current),
                  zhNormDelta: zhNormDeltaForGate || undefined,
                  enNormDelta: enNormDeltaForGate || undefined,
                },
              });
            }
            // #endregion
            /* Do not record digest: same partial may arrive again with higher RMS (was starving advances). */
            continue;
          }
          // #region agent log
          const delta = next - prevEnd;
          const nt = Date.now();
          if (nt - _dwFollowPumpLogTs > 90 || delta > 60 || (kind === "partial" && opts.lang === "zh" && delta > 8)) {
            _dwFollowPumpLogTs = nt;
            dwFollowLog({
              location: "useVoskTeleprompterFollow.ts:pump",
              message: "readEnd advance",
              hypothesisId: "H_C",
              data: {
                kind,
                prevEnd,
                next,
                delta,
                maxNormAdvance: matchOpts.maxNormAdvance,
                qRem: queue.length,
                spokenTail: spokenFull.slice(-56),
                rms: Math.round(rms * 10000) / 10000,
                zhPartialNoSoftCap: opts.lang === "zh" && kind === "partial",
                normKeyLen,
                lastAdvanceNormKeyLen: lastAdvanceNormKeyLenRef.current,
                zhNormDeltaGate: opts.lang === "zh" && kind === "partial" ? zhNormDeltaForGate : undefined,
                rmsFloorUsed: kind === "final" ? undefined : rmsFloor,
              },
            });
          }
          // #endregion
          lastVoskDigestRef.current = digest;
          readEndRef.current = next;
          lastAdvanceNormKeyLenRef.current = normKeyLen;
          advancesThisTurn += 1;
          setReadChars(next);
          if (followLatencyProf) {
            const tNow = typeof performance !== "undefined" ? performance.now() : Date.now();
            const sincePrev =
              followLatencyProf.lastAdvanceMs > 0 ? tNow - followLatencyProf.lastAdvanceMs : undefined;
            followLatencyProf.lastAdvanceMs = tNow;
            if (tNow - followLatencyProf.lastLogMs >= 500) {
              followLatencyProf.lastLogMs = tNow;
              const avg =
                followLatencyProf.feedCount > 0
                  ? followLatencyProf.feedSumMs / followLatencyProf.feedCount
                  : 0;
              console.log("[follow-latency]", {
                queueRem: queue.length,
                avgFeedMs: Math.round(avg * 100) / 100,
                advanceIntervalMs: sincePrev != null ? Math.round(sincePrev) : undefined,
              });
              followLatencyProf.feedSumMs = 0;
              followLatencyProf.feedCount = 0;
            }
          }
          // #region agent log
          const tAdv = Date.now();
          if (tAdv - _dw7306AdvanceTs > 200) {
            _dw7306AdvanceTs = tAdv;
            fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
              body: JSON.stringify({
                sessionId: "dc7a9b",
                location: "useVoskTeleprompterFollow.ts:readAdvance",
                message: "readEnd advanced",
                hypothesisId: "F3",
                data: { prevEnd, next, delta: next - prevEnd, kind },
                timestamp: tAdv,
              }),
            }).catch(() => {});
          }
          // #endregion
        } catch (e) {
          if (!ipcErrRef.current) {
            ipcErrRef.current = true;
            setError(e instanceof Error ? e.message : "Vosk feed IPC failed.");
          }
        }
      }
      } finally {
        feeding = false;
        if (queue.length > 0 && !cancelled) {
          queueMicrotask(() => {
            void pump();
          });
        }
        // #region agent log
        if (queue.length > 0 && (feedsThisTurn >= PUMP_MAX_FEEDS_PER_TURN || advancesThisTurn >= maxAdvancesThisPump)) {
          dwFollowLog({
            location: "useVoskTeleprompterFollow.ts:pump",
            message: "pump yield — queue backlog (H_burst)",
            hypothesisId: "H_burst",
            data: { feedsThisTurn, advancesThisTurn, qRem: queue.length },
          });
        }
        // #endregion
      }
    };

    const enqueue = (pcm: Int16Array) => {
      pendingPcm = pendingPcm.length === 0 ? pcm : mergeInt16(pendingPcm, pcm);
      while (pendingPcm.length >= CHUNK_SAMPLES && !cancelled) {
        const slice = pendingPcm.subarray(0, CHUNK_SAMPLES);
        pendingPcm = pendingPcm.length > CHUNK_SAMPLES ? pendingPcm.subarray(CHUNK_SAMPLES) : new Int16Array(0);
        queue.push(Int16Array.from(slice));
        void pump();
      }
    };

    (async () => {
      // #region agent log
      const coldT0 = Date.now();
      // #endregion
      const mp = await api.voskModelPath!(opts.lang);
      // #region agent log
      dwFollowLog({
        location: "useVoskTeleprompterFollow.ts:cold",
        message: "modelPath resolved",
        hypothesisId: "H_A",
        data: { ms: Date.now() - coldT0, ok: mp.ok, lang: opts.lang },
      });
      dwDebug6({
        hypothesisId: "H_LOAD_PATH",
        location: "useVoskTeleprompterFollow.ts:cold",
        message: "voskModelPath ipc done",
        data: { msFromFollowStart: Date.now() - coldT0, ok: mp.ok, lang: opts.lang },
      });
      // #endregion
      if (cancelled) return;
      if (!mp.ok) {
        // #region agent log
        fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
          body: JSON.stringify({
            sessionId: "dc7a9b",
            location: "useVoskTeleprompterFollow.ts:modelPath",
            message: "vosk model path not ok",
            hypothesisId: "H5",
            data: { branch: "no_model", pathLen: mp.path?.length ?? 0 },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
        void ctxRef.current?.close();
        ctxRef.current = null;
        setStatus("");
        setError(
          `No Vosk model in:\n${mp.path}\n\nUnpack a model from https://alphacephei.com/vosk/models into that folder (see am/final.mdl).`
        );
        return;
      }

      let init: { ok: boolean; error?: string };
      let stream: MediaStream;
      try {
        const tPar = Date.now();
        const pInit = api.voskInit!(mp.path).then((r) => {
          // #region agent log
          dwDebug6({
            hypothesisId: "H_LOAD_PARALLEL",
            location: "useVoskTeleprompterFollow.ts:cold",
            message: "voskInit ipc resolved",
            data: { msFromParallelStart: Date.now() - tPar },
          });
          // #endregion
          return r;
        });
        const pMic = navigator.mediaDevices
          .getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          })
          .then((s) => {
            // #region agent log
            dwDebug6({
              hypothesisId: "H_LOAD_PARALLEL",
              location: "useVoskTeleprompterFollow.ts:cold",
              message: "getUserMedia resolved",
              data: { msFromParallelStart: Date.now() - tPar },
            });
            // #endregion
            return s;
          });
        [init, stream] = await Promise.all([pInit, pMic]);
        // #region agent log
        dwDebug6({
          hypothesisId: "H_LOAD_PARALLEL",
          location: "useVoskTeleprompterFollow.ts:cold",
          message: "Promise.all voskInit+getUserMedia done",
          data: { parallelWallMs: Date.now() - tPar, msFromFollowStart: Date.now() - coldT0 },
        });
        // #endregion
      } catch {
        void ctxRef.current?.close();
        ctxRef.current = null;
        setStatus("");
        setError("Microphone permission denied.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!init.ok) {
        // #region agent log
        fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
          body: JSON.stringify({
            sessionId: "dc7a9b",
            location: "useVoskTeleprompterFollow.ts:voskInit",
            message: "voskInit failed",
            hypothesisId: "H5",
            data: {
              branch: "init_fail",
              errSnippet: (init.error ?? "").slice(0, 120),
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
        stream.getTracks().forEach((t) => t.stop());
        void ctxRef.current?.close();
        ctxRef.current = null;
        setStatus("");
        setError(init.error || "Vosk failed to start.");
        return;
      }
      // #region agent log
      dwFollowLog({
        location: "useVoskTeleprompterFollow.ts:cold",
        message: "init and mic granted",
        hypothesisId: "H_A",
        data: { ms: Date.now() - coldT0, initOk: true },
      });
      dwDebug6({
        hypothesisId: "H_LOAD_AUDIO",
        location: "useVoskTeleprompterFollow.ts:cold",
        message: "vosk init ok + mic stream before AudioContext",
        data: { msFromFollowStart: Date.now() - coldT0 },
      });
      // #endregion
      mediaStream = stream;
      setError(null);
      setStatus("Listening…");

      if (cancelled) return;

      if (!ctxRef.current) {
        ctxRef.current = new AudioContext({ latencyHint: "interactive" });
      }
      const audioCtx = ctxRef.current;
      try {
        if (audioCtx.state === "suspended") await audioCtx.resume();
      } catch {
        void ctxRef.current?.close();
        ctxRef.current = null;
        setError("Could not start the audio engine (microphone graph).");
        return;
      }
      if (cancelled) return;

      const cap = startTeleprompterMicPcm16k(mediaStream, audioCtx, enqueue);
      micStartedAtMs = Date.now();
      // #region agent log
      dwFollowLog({
        location: "useVoskTeleprompterFollow.ts:cold",
        message: "mic pcm pipeline started",
        hypothesisId: "H_A",
        data: { ms: Date.now() - coldT0 },
      });
      dwDebug6({
        hypothesisId: "H_LOAD_AUDIO",
        location: "useVoskTeleprompterFollow.ts:cold",
        message: "Listening — mic pcm pipeline started",
        data: { msFromFollowStart: Date.now() - coldT0 },
      });
      // #endregion
      stopMicCapture = cap.stop;
      if (cap.releasedAudioContext) {
        void ctxRef.current?.close();
        ctxRef.current = null;
      }
      if (cancelled) return;
    })();

    return () => {
      cancelled = true;
      applyScriptReadAnchorRef.current = () => {};
      pendingPcm = new Int16Array(0);
      queue.length = 0;
      try {
        stopMicCapture?.();
      } catch {
        /* ignore */
      }
      stopMicCapture = null;
      mediaStream?.getTracks().forEach((t) => t.stop());
      void ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, [opts.active, opts.lang]);

  const applyScriptReadAnchor = useCallback((scriptCharIndex: number, anchorOpts?: { allowBackward?: boolean }) => {
    applyScriptReadAnchorRef.current(scriptCharIndex, anchorOpts);
  }, []);

  return { readChars, error, status, applyScriptReadAnchor };
}
