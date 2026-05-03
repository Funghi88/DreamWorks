import { EditorContent, useEditor } from "@tiptap/react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CSSProperties, MutableRefObject, RefObject } from "react";
import {
  getTeleprompterFollowPlainExtensions,
  getTeleprompterMarkdownExtensions,
  TELEPROMPTER_OVERLAY_READONLY_CLASS,
  TELEPROMPTER_OVERLAY_READONLY_PLAIN_CLASS,
} from "@/lib/teleprompterTiptapExtensions";
import {
  displayScriptToFollowPlainParagraphs,
  jsonDocFromFollowPlainParagraphs,
} from "@/lib/teleprompterFollowPlainDoc";
import {
  FOLLOW_DOC_BLOCK_SEP,
  FOLLOW_DOC_LEAF_TEXT,
  TeleprompterFollowReadHighlight,
  docPlainTextForFollow,
  docPosAtFirstUnreadPlain,
  teleprompterFollowReadPluginKey,
} from "@/extensions/teleprompterFollowReadHighlight";
import { readCharsForPlainTextOffset, scriptIndexToPlainTextOffset } from "@/lib/teleprompterFollowPlainMap";
import {
  followReadBottomUrgencyBoost,
  followReadLineAnchorScrollStep,
  followReadScrollTopLerp,
  followReadScrollUpGapComfortBand,
  shouldResetFollowAnchorSmooth,
} from "@/lib/teleprompterFollowScrollGuards";
import type { TeleprompterVoskLang } from "@/hooks/useVoskTeleprompterFollow";

/** Comfort band lower edge: read line settles near mid-viewport (~42% from top). */
const FOLLOW_READ_BAND_MAX_FRAC = 0.42;
/** Hysteresis below band max edge, in line-heights — reduces jitter at the boundary. */
const FOLLOW_BAND_HYST_LINE_FRAC = 0.42;
/** Bottom strip: urgency boost earlier after anchor moved up (was 0.2). */
const FOLLOW_BOTTOM_DANGER_FRAC = 0.26;
/** Passed to scroll guards; speech rate does not scale this (avoids “faster and faster” scroll). */
const FOLLOW_SCROLL_MAX_STEP_PX = 104;
/** Slightly higher cap so catch-up stays continuous when paired with smaller per-frame steps. */
const FOLLOW_SCROLL_MAX_PX_PER_SEC = 420;
/** Minimum gap (px) before nudging; line-relative floor applied at runtime. */
const FOLLOW_SCROLL_MIN_DELTA_PX = 0.55;
/** Do not react to sub-line jitter; scroll in gentle steps once gap exceeds ~⅓ line. */
const FOLLOW_SCROLL_LINE_DEAD_FRAC = 0.30;
/** Cap per-frame motion vs line height so motion reads as a slow pull, not a snap. */
const FOLLOW_SCROLL_MAX_STEP_LINE_FRAC = 0.48;
/** Ignore coordsAtPos sub-line jitter below this fraction of line height (feeds EMA + band raw Y). */
const FOLLOW_RAW_CENTER_MICRO_JITTER_FRAC = 0.18;
/** Slow speech: smoother line Y (less jitter). Fast speech: tighter to coords (snappier). */
const FOLLOW_ANCHOR_SMOOTH_SLOW = 0.58;
const FOLLOW_ANCHOR_SMOOTH_FAST = 0.24;

type Props = {
  markdown: string;
  className?: string;
  style?: CSSProperties;
  /** Voice-follow karaoke: script char index from Vosk matcher (same string as `markdown`). */
  followReadChars?: number;
  /** @deprecated Length is taken from `markdown`; kept for call-site clarity. */
  followSourceLen?: number;
  /** Must match speech model — drives norm mapping markdown ↔ plain. */
  followLang?: TeleprompterVoskLang;
  /** When overlay size / font changes, rebuild follow decorations. */
  followLayoutSync?: string;
  /** Follow overlay: scrollable viewport (`overflow-y-auto`) to keep the read line in view. */
  followScrollViewportRef?: RefObject<HTMLDivElement | null>;
  /** When true, apply follow auto-scroll (overlay follow mode). */
  followAutoScroll?: boolean;
  /** Return false while user wheel/scroll pause — do not fight manual scroll. */
  followAutoScrollAllowedRef?: MutableRefObject<() => boolean>;
  /** Mark programmatic scroll so `onScroll` does not treat as user intent. */
  onFollowScrollProgrammatic?: () => void;
};

export type TeleprompterReadonlyDocHandle = {
  /** Map viewport read-band hit → script char index (follow plain doc only). */
  getReadCharsAnchorFromViewportBand: () => number | null;
};

/**
 * Read-only overlay: Markdown rendering when not in voice-follow auto-scroll; in follow mode,
 * stripped paragraph-only doc (no Markdown extension) so `plain` stays stable for karaoke + scroll.
 */
export const TeleprompterReadonlyDoc = forwardRef<TeleprompterReadonlyDocHandle, Props>(function TeleprompterReadonlyDoc(
  {
    markdown,
    className,
    style,
    followReadChars,
    followSourceLen: _followSourceLen,
    followLang = "zh",
    followLayoutSync,
    followScrollViewportRef,
    followAutoScroll = false,
    followAutoScrollAllowedRef,
    onFollowScrollProgrammatic,
  },
  ref,
) {
  /** Follow overlay only: render stripped paragraphs (no Markdown extension) to avoid plain-offset churn. */
  const followPlainDoc = followAutoScroll === true;
  const lastMarkdownContentRef = useRef<string | null>(null);
  const anchorLineCenterSmoothRef = useRef<number | null>(null);
  /** Last followReadChars — detect backward seek. */
  const lastFollowReadCharsRef = useRef<number | null>(null);
  /**
   * Monotonic plain offset for grey + scroll anchor. When TipTap `plain` shifts (markdown layout / CJK-Latin wrap),
   * `scriptIndexToPlainTextOffset` can step **backward** for the same readChars → grey shrinks → “flash white” + scroll hunts.
   */
  const monotonicEndPlainRef = useRef(0);
  /** EMA chars/ms from followReadChars — anchor line Y smoothing only (not scroll step size). */
  const followSpeechRateRef = useRef(0);
  const lastRateSampleRef = useRef<{ chars: number; t: number } | null>(null);
  const followScrollUnmountRef = useRef(false);
  /** Latest followReadChars for the continuous scroll rAF (avoids stale closure). */
  const followReadCharsLiveRef = useRef(followReadChars);
  followReadCharsLiveRef.current = followReadChars;
  /** Throttle parent programmatic-scroll guard (avoid per-frame mark). */
  const lastFollowProgScrollMarkTsRef = useRef(0);
  /** Stabilized screen Y for read line (micro-jitter gate); reset with script/anchor. */
  const rawCenterStableRef = useRef<number | null>(null);

  useEffect(() => {
    followScrollUnmountRef.current = false;
    return () => {
      followScrollUnmountRef.current = true;
    };
  }, []);

  useEffect(() => {
    anchorLineCenterSmoothRef.current = null;
    lastFollowReadCharsRef.current = null;
    monotonicEndPlainRef.current = 0;
    followSpeechRateRef.current = 0;
    lastRateSampleRef.current = null;
    rawCenterStableRef.current = null;
  }, [markdown, followLayoutSync]);

  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: followPlainDoc
      ? [...getTeleprompterFollowPlainExtensions(), TeleprompterFollowReadHighlight]
      : [...getTeleprompterMarkdownExtensions({ includePlaceholder: false }), TeleprompterFollowReadHighlight],
    content: followPlainDoc
      ? jsonDocFromFollowPlainParagraphs(displayScriptToFollowPlainParagraphs(markdown))
      : markdown,
    contentType: followPlainDoc ? undefined : "markdown",
    editorProps: {
      attributes: {
        class: className ?? (followPlainDoc ? TELEPROMPTER_OVERLAY_READONLY_PLAIN_CLASS : TELEPROMPTER_OVERLAY_READONLY_CLASS),
      },
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      getReadCharsAnchorFromViewportBand: (): number | null => {
        if (!followPlainDoc || !editor || !followScrollViewportRef?.current) return null;
        const vp = followScrollViewportRef.current;
        const rect = vp.getBoundingClientRect();
        const x = rect.left + rect.width * 0.5;
        const baseY = rect.top + rect.height * FOLLOW_READ_BAND_MAX_FRAC;
        const view = editor.view;
        let pos: number | null = null;
        for (const dy of [0, -6, 6, -12, 12, -18, 18, -24, 24]) {
          const hit = view.posAtCoords({ left: x, top: baseY + dy });
          if (hit && typeof hit.pos === "number") {
            pos = hit.pos;
            break;
          }
        }
        if (pos == null) return null;
        const doc = editor.state.doc;
        const clamped = Math.max(0, Math.min(pos, doc.content.size));
        const prefix = doc.textBetween(0, clamped, FOLLOW_DOC_BLOCK_SEP, FOLLOW_DOC_LEAF_TEXT);
        const plainFull = docPlainTextForFollow(doc);
        const plainOffset = prefix.length;
        return readCharsForPlainTextOffset(markdown, plainOffset, plainFull, followLang);
      },
    }),
    [editor, followLang, followPlainDoc, followScrollViewportRef, markdown],
  );

  useEffect(() => {
    if (!editor) return;
    if (followPlainDoc) {
      if (lastMarkdownContentRef.current !== markdown) {
        lastMarkdownContentRef.current = markdown;
        editor.commands.setContent(
          jsonDocFromFollowPlainParagraphs(displayScriptToFollowPlainParagraphs(markdown)),
        );
      }
    } else {
      lastMarkdownContentRef.current = null;
      if (editor.getMarkdown() !== markdown) {
        editor.commands.setContent(markdown, { contentType: "markdown" });
      }
    }
    queueMicrotask(() => {
      if (!editor) return;
      if (followReadChars == null || followReadChars < 0) {
        monotonicEndPlainRef.current = 0;
        lastFollowReadCharsRef.current = null;
        editor.view.dispatch(
          editor.state.tr.setMeta(teleprompterFollowReadPluginKey, { endPlainOffset: 0 }),
        );
        return;
      }
      const plain = docPlainTextForFollow(editor.state.doc);
      const prevCharsForPlain = lastFollowReadCharsRef.current;
      if (prevCharsForPlain != null && followReadChars < prevCharsForPlain - 2) {
        monotonicEndPlainRef.current = 0;
        anchorLineCenterSmoothRef.current = null;
        rawCenterStableRef.current = null;
        followSpeechRateRef.current = 0;
        lastRateSampleRef.current = null;
      }
      lastFollowReadCharsRef.current = followReadChars;
      const raw = Math.min(plain.length, scriptIndexToPlainTextOffset(markdown, followReadChars, plain, followLang));
      const prev = Math.min(monotonicEndPlainRef.current, plain.length);
      const endOff = Math.min(plain.length, Math.max(prev, raw));
      monotonicEndPlainRef.current = endOff;
      editor.view.dispatch(
        editor.state.tr.setMeta(teleprompterFollowReadPluginKey, { endPlainOffset: endOff }),
      );
    });
  }, [markdown, editor, followReadChars, followLang, followLayoutSync, followPlainDoc]);

  /**
   * Continuous rAF scroll: keeps the first-unread line near the anchor band **while** speech advances,
   * instead of only nudging when `readChars` updates (which felt like “whole page turns gray, then jump”).
   */
  useEffect(() => {
    if (!editor || !followAutoScroll || !followScrollViewportRef) return;

    let cancelled = false;
    let rafId = 0;
    let lastRafMs: number | null = null;

    const tick = () => {
      if (cancelled || followScrollUnmountRef.current) return;
      rafId = requestAnimationFrame(tick);

      const ch = followReadCharsLiveRef.current;
      if (ch == null || ch < 0) return;
      const allowed = followAutoScrollAllowedRef?.current;
      if (allowed && !allowed()) return;

      const vp = followScrollViewportRef.current;
      if (!vp) return;

      const now = performance.now();
      const dtSec =
        lastRafMs == null ? 1 / 60 : Math.min(0.05, Math.max(1 / 240, (now - lastRafMs) / 1000));
      lastRafMs = now;
      const prevSample = lastRateSampleRef.current;
      if (prevSample) {
        if (ch === prevSample.chars) {
          followSpeechRateRef.current *= 0.91;
        } else if (ch > prevSample.chars) {
          const dc = ch - prevSample.chars;
          const dt = now - prevSample.t;
          if (dt > 0 && dt < 1200) {
            const inst = Math.min(0.14, dc / dt);
            followSpeechRateRef.current = followSpeechRateRef.current * 0.32 + inst * 0.68;
          }
        }
      }
      lastRateSampleRef.current = { chars: ch, t: now };

      const rate = followSpeechRateRef.current;
      const maxStepPx = FOLLOW_SCROLL_MAX_STEP_PX;
      const anchorT = Math.min(1, Math.max(0, rate * 44));
      const anchorSmooth =
        FOLLOW_ANCHOR_SMOOTH_FAST + (FOLLOW_ANCHOR_SMOOTH_SLOW - FOLLOW_ANCHOR_SMOOTH_FAST) * (1 - anchorT);

      const doc = editor.state.doc;
      const plain = docPlainTextForFollow(doc);
      if (plain.length === 0) return;
      const endOff = Math.min(plain.length, monotonicEndPlainRef.current);
      let pos: number;
      if (endOff <= 0) {
        pos = 1;
      } else if (endOff >= plain.length) {
        pos = Math.max(1, doc.content.size - 2);
      } else {
        pos = docPosAtFirstUnreadPlain(doc, endOff);
        if (pos === 0 && doc.content.size > 1) pos = 1;
        if (pos >= doc.content.size) pos = Math.max(1, doc.content.size - 1);
      }
      let coords: { top: number; bottom: number };
      try {
        coords = editor.view.coordsAtPos(pos);
      } catch {
        return;
      }
      const vpRect = vp.getBoundingClientRect();
      const vh = vpRect.height;
      const lineHeightPx = Math.max(16, coords.bottom - coords.top);
      const rawCenter = (coords.top + coords.bottom) / 2;
      const prevY = anchorLineCenterSmoothRef.current;
      const jumpReset = shouldResetFollowAnchorSmooth(prevY, rawCenter, vh);
      const microPx = lineHeightPx * FOLLOW_RAW_CENTER_MICRO_JITTER_FRAC;
      let rawStable: number;
      if (jumpReset) {
        rawStable = rawCenter;
        rawCenterStableRef.current = rawCenter;
      } else {
        const rs = rawCenterStableRef.current;
        if (rs != null && Math.abs(rawCenter - rs) < microPx) {
          rawStable = rs;
        } else {
          rawStable = rawCenter;
          rawCenterStableRef.current = rawCenter;
        }
      }

      let lineCenter: number;
      if (jumpReset) {
        lineCenter = rawCenter;
        anchorLineCenterSmoothRef.current = rawCenter;
      } else {
        /** When the read line jumps down faster than EMA, smoothing lags and underestimates scroll gap — text stacks at the bottom. */
        let smoothUse = anchorSmooth;
        if (prevY != null && rawCenter - prevY > vh * 0.1) {
          smoothUse = Math.min(smoothUse, FOLLOW_ANCHOR_SMOOTH_FAST);
        }
        lineCenter = prevY == null ? rawStable : prevY * smoothUse + rawStable * (1 - smoothUse);
        anchorLineCenterSmoothRef.current = lineCenter;
      }

      const hystPx = lineHeightPx * FOLLOW_BAND_HYST_LINE_FRAC;
      const gap = followReadScrollUpGapComfortBand({
        lineCenterY: lineCenter,
        rawCenterY: rawStable,
        viewportTop: vpRect.top,
        viewportHeightPx: vh,
        bandMaxFrac: FOLLOW_READ_BAND_MAX_FRAC,
        hysteresisPx: hystPx,
      });
      const minGapPx = Math.max(FOLLOW_SCROLL_MIN_DELTA_PX, lineHeightPx * FOLLOW_SCROLL_LINE_DEAD_FRAC);
      if (gap <= minGapPx) return;

      const urgencyBase = Math.min(2.6, gap / Math.max(48, vh * 0.085));
      const bottomBoost = followReadBottomUrgencyBoost({
        rawCenterY: rawStable,
        viewportTop: vpRect.top,
        viewportBottom: vpRect.bottom,
        bottomDangerFrac: FOLLOW_BOTTOM_DANGER_FRAC,
      });
      const urgency = Math.min(2.6, urgencyBase + bottomBoost);
      const stepCapPx = Math.min(maxStepPx, lineHeightPx * FOLLOW_SCROLL_MAX_STEP_LINE_FRAC);
      const { movePx, largeGap } = followReadLineAnchorScrollStep({
        gapPx: gap,
        viewportHeightPx: vh,
        maxStepPx: stepCapPx,
        urgency,
      });

      const maxS = Math.max(0, vp.scrollHeight - vp.clientHeight);
      let nextScroll = followReadScrollTopLerp(vp.scrollTop, maxS, movePx, largeGap, urgency);
      const curTop = vp.scrollTop;
      const maxDeltaPx = FOLLOW_SCROLL_MAX_PX_PER_SEC * dtSec;
      let delta = Math.min(nextScroll - curTop, maxDeltaPx);
      const stepQ = Math.max(1, lineHeightPx / 8);
      delta = Math.round(delta / stepQ) * stepQ;
      nextScroll = Math.min(maxS, curTop + delta);
      if (nextScroll <= curTop + 0.12) return;

      vp.scrollTop = nextScroll;

      if (now - lastFollowProgScrollMarkTsRef.current > 100) {
        lastFollowProgScrollMarkTsRef.current = now;
        onFollowScrollProgrammatic?.();
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [
    editor,
    markdown,
    followLayoutSync,
    followAutoScroll,
    followScrollViewportRef,
    followAutoScrollAllowedRef,
    onFollowScrollProgrammatic,
  ]);

  if (!editor) {
    return <div className="min-w-0" style={style} aria-hidden />;
  }

  return (
    <div
      className="min-w-0 w-full max-w-3xl mx-auto [&_.ProseMirror]:text-left [&_.ProseMirror]:[text-wrap:pretty]"
      style={style}
      data-teleprompter-readonly-doc=""
    >
      <EditorContent editor={editor} />
    </div>
  );
});
