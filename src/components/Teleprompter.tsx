import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from "react";
import { createPortal } from "react-dom";
import { GlassButton } from "@/components/Glass";
import { useVoskTeleprompterFollow, type TeleprompterVoskLang } from "@/hooks/useVoskTeleprompterFollow";
import { handleTeleprompterFollowToggle } from "@/lib/teleprompterVoiceFollowAudio";
import {
  TeleprompterReadonlyDoc,
  type TeleprompterReadonlyDocHandle,
} from "@/components/TeleprompterReadonlyDoc";
import { TeleprompterScriptEditor, type TeleprompterScriptEditorHandle } from "@/components/TeleprompterScriptEditor";
import { collapseBlankLines } from "@/lib/teleprompterMarkdown";
import { TELEPROMPTER_EDITOR_HTML_CLASS } from "@/lib/teleprompterTiptapExtensions";
import { normalizeTeleprompterImportedText } from "@/lib/teleprompterImport";
import { DREAMWORK_FLUSH_TELEPROMPTER_DRAFT } from "@/lib/storage";
import { followScrollFraction, readCharsForFollowScrollFraction } from "@/lib/teleprompterFollowPlainMap";
import {
  FOLLOW_SCROLL_TOP_GHOST_LT,
  FOLLOW_SCROLL_TOP_RESTORE_LAST_GT,
  isCollapsedLayout,
  shouldRestoreFollowScrollTop,
} from "@/lib/teleprompterFollowScrollGuards";

/** After manual seek applies, resume line-anchor scroll before generic scroll bumpPause (8s). */
const FOLLOW_MANUAL_ANCHOR_RESUME_MS = 900;

interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// #region agent log
let _dwKaraokeLogTs = 0;
let _dwScrollGuardLogTs = 0;
let _dwUserScrollLogTs = 0;
// #endregion

interface TeleprompterOverlayProps {
  isVisible: boolean;
  script: string;
  isPlaying: boolean;
  speed: number;
  fontSize: number;
  opacity: number;
  overlayWidth: number;
  overlayHeight: number;
  nearCamera: boolean;
  anchorRect: AnchorRect | null;
  position: { x: number; y: number } | null;
  locked: boolean;
  resetSignal: number;
  editorScrollRatio?: number | null;
  followMode?: boolean;
  onSetFollowMode?: (on: boolean) => void;
  slimMode?: boolean;
  onSetSlimMode?: (on: boolean) => void;
  onSetPlaying: (playing: boolean) => void;
  onPositionChange: (position: { x: number; y: number }) => void;
  onOverlaySizeChange: (width: number, height: number) => void;
  onDragStart: () => void;
  onToggleLocked: () => void;
  onReset: () => void;
  onHide: () => void;
  onNudgeSpeed: (delta: number) => void;
  /** Vosk model language (userData/vosk-models/{en|zh|it}). */
  voskLang?: TeleprompterVoskLang;
  /** Stable id of the active script tab — avoids treating every keystroke as a new script for follow state. */
  followScriptIdentity?: string;
  /** Electron screen-share: constrain overlay to the whiteboard column rect (getBoundingClientRect). */
  dockColumnRect?: AnchorRect | null;
  /** When true, Vosk/mic follow runs in the detached helper window — disable here to avoid duplicate engines. */
  muteVoskForDetachedHelper?: boolean;
  /** Render inside Electron `teleprompter-helper` BrowserWindow (fill parent, no fixed viewport drag). */
  embeddedInDetachedHelperWindow?: boolean;
  /** Dedicated `teleprompter-slim` BrowserWindow — fill window; drag moves OS window, not in-page offset. */
  embeddedInSlimBrowserWindow?: boolean;
  /** When set with `embeddedInDetachedHelperWindow`, show model language selector next to Follow. */
  onSetVoskLang?: (lang: TeleprompterVoskLang) => void;
}

interface TeleprompterScriptItem {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
}

interface TeleprompterPanelProps {
  isVisible: boolean;
  isPlaying: boolean;
  script: string;
  scripts: TeleprompterScriptItem[];
  activeScriptId: string;
  onSwitchScript: (id: string) => void;
  onNewScript: () => void;
  /** Add scripts from disk (.txt / .md); names derived from filenames. */
  onImportScripts: (items: { name: string; content: string }[]) => void;
  onSaveAsScript: () => void;
  onRenameScript: (newName: string) => void;
  speed: number;
  fontSize: number;
  opacity: number;
  overlayWidth: number;
  nearCamera: boolean;
  locked: boolean;
  position: { x: number; y: number } | null;
  /** Editor panel dimensions (persisted). */
  panelWidth: number;
  panelHeight: number;
  onPanelSizeChange: (width: number, height: number) => void;
  onSetScript: (value: string) => void;
  onSetPlaying: (playing: boolean) => void;
  onSetSpeed: (value: number) => void;
  onSetFontSize: (value: number) => void;
  onSetOpacity: (value: number) => void;
  onSetOverlayWidth: (value: number) => void;
  onSetNearCamera: (value: boolean) => void;
  onPositionChange: (position: { x: number; y: number }) => void;
  onToggleLocked: () => void;
  onReset: () => void;
  onHide: () => void;
  /** Pass latest textarea text so disk save runs in the same tick as ⌘S (parent state may not have flushed yet). */
  onFlushSave?: (latestScriptContent?: string) => void;
  onEditorScroll?: (ratio: number) => void;
  followMode?: boolean;
  onSetFollowMode?: (on: boolean) => void;
  voskLang?: TeleprompterVoskLang;
  onSetVoskLang?: (lang: TeleprompterVoskLang) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function getViewportSize() {
  if (typeof window === "undefined") return { width: 1280, height: 720 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function isElectronVosk(): boolean {
  if (typeof window === "undefined") return false;
  const api = (window as unknown as { electronAPI?: { isElectron?: boolean; voskInit?: unknown; voskFeed?: unknown } })
    .electronAPI;
  if (!api?.voskInit || !api?.voskFeed) return false;
  if (api.isElectron === false) return false;
  return true;
}

function teleprompterNameFromFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const stripped = base.replace(/\.(md|txt|markdown|script)$/i, "").trim();
  return stripped.length > 0 ? stripped : "Imported";
}

function clampScroll(
  viewport: HTMLDivElement | null,
  scrollContent: HTMLDivElement | null,
  scrollPxRef: { current: number }
) {
  if (!viewport || !scrollContent) return;
  const maxScrollPx = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  scrollPxRef.current = Math.min(scrollPxRef.current, maxScrollPx);
  scrollContent.style.transform = `translateY(${-scrollPxRef.current}px)`;
}

function useTeleprompterScroll({
  isVisible,
  isPlaying,
  speed,
  script,
  fontSize,
  overlayWidth,
  overlayHeight,
  onSetPlaying,
  resetSignal,
  editorScrollRatio,
}: {
  isVisible: boolean;
  isPlaying: boolean;
  speed: number;
  script: string;
  fontSize: number;
  overlayWidth: number;
  overlayHeight: number;
  onSetPlaying: (playing: boolean) => void;
  resetSignal?: number;
  editorScrollRatio?: number | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const scrollPxRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (resetSignal != null) {
      scrollPxRef.current = 0;
      lastTsRef.current = null;
      const el = scrollContentRef.current;
      if (el) el.style.transform = "translateY(0px)";
    }
  }, [resetSignal]);

  // When script or layout (fontSize, size) changes: preserve scroll position, clamp to max
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      clampScroll(viewportRef.current, scrollContentRef.current, scrollPxRef);
    });
    return () => cancelAnimationFrame(raf);
  }, [script, fontSize, overlayWidth, overlayHeight]);

  // Sync scroll from editor (right panel) when user scrolls the textarea
  useEffect(() => {
    if (editorScrollRatio == null || typeof editorScrollRatio !== "number") return;
    const viewport = viewportRef.current;
    const el = scrollContentRef.current;
    if (!viewport || !el) return;
    const maxScrollPx = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    scrollPxRef.current = Math.max(0, Math.min(editorScrollRatio * maxScrollPx, maxScrollPx));
    el.style.transform = `translateY(${-scrollPxRef.current}px)`;
  }, [editorScrollRatio]);

  useEffect(() => {
    if (!isVisible || !isPlaying) return;
    let raf = 0;
    const tick = (ts: number) => {
      const viewport = viewportRef.current;
      const maxScrollPx = viewport ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : 0;
      const prevTs = lastTsRef.current ?? ts;
      const dt = (ts - prevTs) / 1000;
      lastTsRef.current = ts;
      const next = Math.min(scrollPxRef.current + speed * dt, maxScrollPx);
      scrollPxRef.current = next;
      const el = scrollContentRef.current;
      if (el) el.style.transform = `translateY(${-next}px)`;
      if (maxScrollPx > 0 && next >= maxScrollPx) onSetPlaying(false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      lastTsRef.current = null;
      // Preserve scroll position when pausing (cleanup runs when isPlaying becomes false)
      const el = scrollContentRef.current;
      if (el) el.style.transform = `translateY(${-scrollPxRef.current}px)`;
    };
  }, [isVisible, isPlaying, speed, onSetPlaying]);

  const reset = useCallback(() => {
    scrollPxRef.current = 0;
    lastTsRef.current = null;
    const el = scrollContentRef.current;
    if (el) el.style.transform = "translateY(0px)";
  }, []);

  const addScrollDelta = useCallback((delta: number) => {
    const viewport = viewportRef.current;
    const el = scrollContentRef.current;
    if (!viewport || !el) return;
    const maxScrollPx = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    scrollPxRef.current = Math.max(0, Math.min(scrollPxRef.current + delta, maxScrollPx));
    el.style.transform = `translateY(${-scrollPxRef.current}px)`;
  }, []);

  return { viewportRef, scrollContentRef, reset, addScrollDelta, scrollPxRef };
}

export const TeleprompterOverlay = memo(function TeleprompterOverlay({
  isVisible,
  script,
  isPlaying,
  speed,
  fontSize,
  opacity,
  overlayWidth,
  overlayHeight,
  nearCamera,
  anchorRect,
  position,
  locked,
  resetSignal,
  editorScrollRatio,
  followMode = false,
  onSetFollowMode,
  slimMode,
  onSetSlimMode,
  onSetPlaying,
  onPositionChange,
  onOverlaySizeChange,
  onDragStart,
  onToggleLocked,
  onReset,
  onHide,
  onNudgeSpeed,
  voskLang = "en",
  followScriptIdentity,
  dockColumnRect = null,
  muteVoskForDetachedHelper = false,
  embeddedInDetachedHelperWindow = false,
  embeddedInSlimBrowserWindow = false,
  onSetVoskLang,
}: TeleprompterOverlayProps) {
  const displayScript = useMemo(() => script ? collapseBlankLines(script) : "", [script]);
  /**
   * Prefer tab id — never fall back to full `displayScript` (every keystroke changed the key → scrollTop=0).
   * If `followScriptIdentity` briefly goes empty between renders, keep last non-empty id.
   */
  const lastNonEmptyFollowScriptIdRef = useRef<string | null>(null);
  const rawFollowScriptId =
    followScriptIdentity != null && followScriptIdentity.length > 0 ? followScriptIdentity : null;
  if (rawFollowScriptId != null) {
    lastNonEmptyFollowScriptIdRef.current = rawFollowScriptId;
  }
  const followIdentityKey =
    rawFollowScriptId ?? lastNonEmptyFollowScriptIdRef.current ?? "__default_follow__";
  const clampedWidth = embeddedInDetachedHelperWindow
    ? Math.max(280, overlayWidth)
    : Math.max(320, Math.min(900, overlayWidth));
  const clampedHeight = embeddedInDetachedHelperWindow
    ? Math.max(160, overlayHeight)
    : Math.max(180, Math.min(500, overlayHeight));
  const useDock =
    dockColumnRect != null && dockColumnRect.width >= 8 && dockColumnRect.height >= 8;
  const effectiveWidth = useDock
    ? Math.min(clampedWidth, Math.max(280, dockColumnRect!.width - 16))
    : clampedWidth;
  const effectiveHeight = useDock
    ? Math.min(clampedHeight, Math.max(180, dockColumnRect!.height - 16))
    : clampedHeight;
  const followLayoutSyncKey = useMemo(
    () => `${effectiveWidth}x${effectiveHeight}x${fontSize}`,
    [effectiveWidth, effectiveHeight, fontSize],
  );

  useEffect(() => {
    // #region agent log
    fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
      body: JSON.stringify({
        sessionId: "dc7a9b",
        location: "TeleprompterOverlay.tsx:scriptProps",
        message: "overlay script visibility",
        hypothesisId: "H2",
        data: {
          isVisible,
          followMode,
          rawScriptLen: script?.length ?? 0,
          displayLen: displayScript.length,
          opacity,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }, [isVisible, followMode, script, displayScript.length, opacity]);

  const speechFollow = useVoskTeleprompterFollow({
    active: !!followMode && !muteVoskForDetachedHelper,
    script: displayScript,
    lang: voskLang,
    resetSignal,
  });
  const applyFollowAnchorRef = useRef<(n: number, opts?: { allowBackward?: boolean }) => void>(() => {});
  applyFollowAnchorRef.current = speechFollow.applyScriptReadAnchor;
  const readChars = followMode ? speechFollow.readChars : 0;
  const readCharsTargetRef = useRef(0);
  readCharsTargetRef.current = readChars;

  const followVisRef = useRef(0);
  const [followVisualChars, setFollowVisualChars] = useState(0);
  followVisRef.current = followVisualChars;
  const displayScriptFollowRef = useRef(displayScript);
  displayScriptFollowRef.current = displayScript;
  const voskLangFollowRef = useRef(voskLang);
  voskLangFollowRef.current = voskLang;

  /**
   * Monotonic follow head for overlay karaoke: never snap back toward the first line after the user
   * has read forward — Vosk/readEnd can spuriously drop to 0 at end-of-utterance or model churn.
   * Allowed decreases: new script tab (`followIdentityKey`), or panel reset (`resetSignal` bump).
   */
  const followScriptKeyForMonotonicRef = useRef(followIdentityKey);
  const prevResetSignalForFollowRef = useRef(resetSignal ?? 0);

  useEffect(() => {
    if (!followMode) {
      followVisRef.current = readChars;
      setFollowVisualChars(readChars);
      return;
    }
    if (followScriptKeyForMonotonicRef.current !== followIdentityKey) {
      followScriptKeyForMonotonicRef.current = followIdentityKey;
      followVisRef.current = readChars;
      setFollowVisualChars(readChars);
      return;
    }
    const prevRs = prevResetSignalForFollowRef.current ?? 0;
    const rs = resetSignal ?? 0;
    if (rs > prevRs) {
      prevResetSignalForFollowRef.current = resetSignal;
      followVisRef.current = readChars;
      setFollowVisualChars(readChars);
      return;
    }
    prevResetSignalForFollowRef.current = resetSignal;

    if (readChars < followVisRef.current) {
      /* Matcher/Vosk can move backward (not only to 0). Any decrease → frac drops → followFracScrollSync yanks the viewport toward the top. Only go back via tab/reset above, or manual seek (sets anchor + state in the same tick). */
      return;
    }
    followVisRef.current = readChars;
    setFollowVisualChars(readChars);
  }, [followMode, readChars, followIdentityKey, resetSignal]);

  const followContentRef = useRef<HTMLDivElement>(null);
  /** Follow plain doc: viewport-band → script anchor for manual skip. */
  const followReadonlyDocRef = useRef<TeleprompterReadonlyDocHandle | null>(null);
  /** Scroll content wrapper (padding + readonly doc). */
  const followInnerRef = useRef<HTMLDivElement>(null);

  /** Declared before follow layout effect so initial align can mark programmatic scroll. */
  const followScrollProgrammaticRef = useRef(false);
  const followProgrammaticScrollAtRef = useRef(0);
  /**
   * Scroll events can fire after followScrollProgrammaticRef clears; without this, onScroll treats
   * them as user intent → bumpPause (H_UI) blocks followFracScrollSync for seconds → drift.
   */
  const followProgrammaticScrollGuardUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  /** Last applied follow scrollTop — used when raw layout reports scrollTop≈0 during transient scrollHeight collapse (log: H_SCROLL_TOP_RESTORE). */
  const followLastGoodScrollTopRef = useRef(0);

  useEffect(() => {
    if (!followMode) {
      followLastGoodScrollTopRef.current = 0;
    }
  }, [followMode]);

  useEffect(() => {
    if (!followMode || !isVisible) return;
    const id = requestAnimationFrame(() => {
      const vp = followContentRef.current;
      const pm = vp?.querySelector(".ProseMirror") as HTMLElement | null;
      // #region agent log
      fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
        body: JSON.stringify({
          sessionId: "dc7a9b",
          location: "TeleprompterOverlay.tsx:followLayout",
          message: "follow viewport vs ProseMirror geometry",
          hypothesisId: "H3",
          data: {
            vpClientH: vp?.clientHeight ?? -1,
            vpScrollH: vp?.scrollHeight ?? -1,
            pmClientH: pm?.clientHeight ?? -1,
            pmChildCount: pm?.childElementCount ?? -1,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    });
    return () => cancelAnimationFrame(id);
  }, [followMode, isVisible, displayScript.length, followVisualChars]);

  useEffect(() => {
    if (!followMode) return;
    // #region agent log
    fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6bad53" },
      body: JSON.stringify({
        sessionId: "6bad53",
        location: "TeleprompterOverlay.tsx:followLayoutSyncKey",
        message: "follow layout key changed — readonly doc will rebuild decorations (H_LAYOUT_RESYNC)",
        hypothesisId: "H_LAYOUT_RESYNC",
        data: { followLayoutSyncKey },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }, [followMode, followLayoutSyncKey]);

  /** User scroll pauses voice-driven scroll sync; programmatic scroll sets followScrollProgrammaticRef. */
  const followEasePauseUntilRef = useRef(0);
  /** After user pause ends, ease in so the first H_SYNC does not snap the viewport (log: jump back). */
  const followWasInUserPauseRef = useRef(false);
  const followResumeEaseUntilRef = useRef(0);
  /** After user wheel/scroll, block programmatic scroll-up (negative delta) — avoids snap-back (log: H_UI then H_SYNC). */
  const followSuppressScrollUpUntilRef = useRef(0);
  /** Ignore transient scrollHeight collapse (decorations/layout) that would snap scrollTop to ~0. */
  const followScrollMaxStableRef = useRef(0);
  /** Debounce manual scroll → script anchor (same norm fraction as `followFracScrollSync`). */
  const manualSeekFromScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** User scrolled up (wheel / gradual drag) — allow manual seek to move anchor backward; otherwise ignore (layout glitches move scrollTop back and would re-highlight earlier text). */
  const allowBackwardManualSeekUntilRef = useRef(0);

  const followAutoScrollAllowedRef = useRef<() => boolean>(() => true);
  followAutoScrollAllowedRef.current = () => Date.now() >= followEasePauseUntilRef.current;

  /** Last time follow line-anchor scroll ran — suppress scrollTop restore briefly to avoid fighting mixed-script layout thrash. */
  const lastFollowAutoScrollTsRef = useRef(0);

  const markFollowProgrammaticScroll = useCallback(() => {
    lastFollowAutoScrollTsRef.current = Date.now();
    followScrollProgrammaticRef.current = true;
    followProgrammaticScrollGuardUntilRef.current = Date.now() + 520;
    followProgrammaticScrollAtRef.current = Date.now();
    /* Scroll events can arrive after rAF; keep flag long enough so onScroll does not bumpPause. */
    window.setTimeout(() => {
      followScrollProgrammaticRef.current = false;
    }, 90);
  }, []);

  useEffect(() => {
    followScrollMaxStableRef.current = 0;
  }, [displayScript.length]);

  /** User wheel/trackpad — extend pause even when scrollTop delta is small (scroll listener alone missed sub-threshold moves). */
  useEffect(() => {
    if (!followMode) return;
    const el = followContentRef.current;
    if (!el) return;
    const bumpPause = () => {
      const t = Date.now();
      /* Long window: frac sync must not override manual scroll (log: 0.75px floor blocked bumpPause → drag never paused). */
      followEasePauseUntilRef.current = t + 8000;
      followSuppressScrollUpUntilRef.current = t + 10000;
    };
    /* Programmatic scroll can emit scroll events after the sync flag clears; guard window avoids false H_UI. */
    const ignoreRecentProgrammatic = () => Date.now() - followProgrammaticScrollAtRef.current < 520;
    const scheduleManualSeekFromUser = () => {
      if (manualSeekFromScrollTimerRef.current != null) {
        clearTimeout(manualSeekFromScrollTimerRef.current);
      }
      manualSeekFromScrollTimerRef.current = setTimeout(() => {
        manualSeekFromScrollTimerRef.current = null;
        const vpSeek = followContentRef.current;
        if (!vpSeek) return;
        const md = displayScriptFollowRef.current;
        if (!md.length) return;
        const maxSeek = Math.max(0, vpSeek.scrollHeight - vpSeek.clientHeight);
        const frac = maxSeek <= 0 ? 0 : Math.max(0, Math.min(1, vpSeek.scrollTop / maxSeek));
        const lang = voskLangFollowRef.current;
        const anchorFrac = readCharsForFollowScrollFraction(md, frac, lang);
        const anchorView = followReadonlyDocRef.current?.getReadCharsAnchorFromViewportBand() ?? null;
        let anchor = anchorFrac;
        if (anchorView != null) {
          anchor = anchorView;
        }
        const cur = followVisRef.current;
        const allowBack = Date.now() < allowBackwardManualSeekUntilRef.current;
        /** User skipped forward in the viewport — do not block anchor with stale scroll-frac guards. */
        const forwardSeek = anchor > cur + 28;
        if (anchor + 12 < cur && !allowBack && !forwardSeek) {
          return;
        }
        const voice = readCharsTargetRef.current;
        if (!allowBack && anchor < voice - 4 && !forwardSeek) {
          return;
        }
        followVisRef.current = anchor;
        setFollowVisualChars(anchor);
        applyFollowAnchorRef.current(anchor, { allowBackward: allowBack });
        followEasePauseUntilRef.current = Date.now() + FOLLOW_MANUAL_ANCHOR_RESUME_MS;
        // #region agent log
        fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6bad53" },
          body: JSON.stringify({
            sessionId: "6bad53",
            hypothesisId: "H_MANUAL_SEEK_ANCHOR",
            location: "Teleprompter.tsx:manualSeekFromScroll",
            message: "manual scroll → readChars + Vosk anchor (match viewport)",
            data: {
              scrollTop: vpSeek.scrollTop,
              maxSeek,
              frac: Math.round(frac * 1000) / 1000,
              anchor,
              anchorFrac,
              anchorView,
              mdLen: md.length,
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
      }, 160);
    };
    const onWheel = (e: WheelEvent) => {
      if (followScrollProgrammaticRef.current || ignoreRecentProgrammatic()) return;
      const now = Date.now();
      if (now < followProgrammaticScrollGuardUntilRef.current) return;
      if (e.deltaY < 0) {
        allowBackwardManualSeekUntilRef.current = Date.now() + 900;
      }
      const vpW = followContentRef.current;
      if (vpW) {
        lastScrollTopRef.current = vpW.scrollTop;
        followLastGoodScrollTopRef.current = vpW.scrollTop;
      }
      bumpPause();
      scheduleManualSeekFromUser();
    };
    const onScroll = () => {
      const now = Date.now();
      if (followScrollProgrammaticRef.current || ignoreRecentProgrammatic()) return;
      if (now < followProgrammaticScrollGuardUntilRef.current) {
        const vpG = followContentRef.current;
        if (vpG) lastScrollTopRef.current = vpG.scrollTop;
        // #region agent log
        const tG = Date.now();
        if (tG - _dwScrollGuardLogTs > 500) {
          _dwScrollGuardLogTs = tG;
          fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6bad53" },
            body: JSON.stringify({
              sessionId: "6bad53",
              hypothesisId: "H_SCROLL_GUARD",
              location: "Teleprompter.tsx:onScroll",
              message: "ignored scroll echo after programmatic scrollTop (avoid false user pause)",
              data: { scrollTop: vpG?.scrollTop },
              timestamp: tG,
            }),
          }).catch(() => {});
        }
        // #endregion
        return;
      }
      const vp = followContentRef.current;
      if (!vp) return;
      const st = vp.scrollTop;
      const prevSt = lastScrollTopRef.current;
      lastScrollTopRef.current = st;
      /* Glitch to top while read head is deep: do not treat as user scroll (would pause frac sync for 8s). */
      const glitchSnapToTop =
        st < 48 && followLastGoodScrollTopRef.current > 120 && followVisRef.current > 72;
      if (glitchSnapToTop) {
        return;
      }
      if (prevSt - st > 4 && prevSt - st < 120) {
        allowBackwardManualSeekUntilRef.current = Date.now() + 900;
      }
      followLastGoodScrollTopRef.current = st;
      bumpPause();
      scheduleManualSeekFromUser();
      // #region agent log
      const tUs = Date.now();
      if (tUs - _dwUserScrollLogTs > 450) {
        _dwUserScrollLogTs = tUs;
        fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6bad53" },
          body: JSON.stringify({
            sessionId: "6bad53",
            hypothesisId: "H_USER_SCROLL_PAUSE",
            location: "Teleprompter.tsx:onScroll",
            message: "user scroll → bumpPause (removed 0.75px floor)",
            data: { scrollTop: st },
            timestamp: tUs,
          }),
        }).catch(() => {});
      }
      // #endregion
    };
    lastScrollTopRef.current = el.scrollTop;
    el.addEventListener("wheel", onWheel as EventListener, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (manualSeekFromScrollTimerRef.current != null) {
        clearTimeout(manualSeekFromScrollTimerRef.current);
        manualSeekFromScrollTimerRef.current = null;
      }
      el.removeEventListener("wheel", onWheel as EventListener);
      el.removeEventListener("scroll", onScroll);
    };
  }, [followMode, slimMode]);

  useEffect(() => {
    if (!followMode) {
      followWasInUserPauseRef.current = false;
      followResumeEaseUntilRef.current = 0;
      followSuppressScrollUpUntilRef.current = 0;
    }
  }, [followMode]);

  /**
   * Follow viewport: restore scrollTop only on layout glitches (ghost ~0 / collapsed height).
   * Continuous scrolling is {@link TeleprompterReadonlyDoc} line-anchor scroll.
   */
  useLayoutEffect(() => {
    if (!followMode || !isVisible || !displayScript.length) return;

    const vp = followContentRef.current;
    if (!vp) return;

    const rawMaxS = Math.max(0, vp.scrollHeight - vp.clientHeight);
    const prevStable = followScrollMaxStableRef.current;
    followScrollMaxStableRef.current = Math.max(prevStable, rawMaxS);
    let maxS = rawMaxS;
    if (isCollapsedLayout(prevStable, rawMaxS)) {
      maxS = prevStable;
    }

    const collapsedLayout = isCollapsedLayout(prevStable, rawMaxS);
    const scrollTopGhostZero =
      !collapsedLayout &&
      rawMaxS > 120 &&
      vp.scrollTop < FOLLOW_SCROLL_TOP_GHOST_LT &&
      followLastGoodScrollTopRef.current > FOLLOW_SCROLL_TOP_RESTORE_LAST_GT;

    const suppressRestoreMs = 720;
    if (
      Date.now() - lastFollowAutoScrollTsRef.current >= suppressRestoreMs &&
      shouldRestoreFollowScrollTop({
        scrollTop: vp.scrollTop,
        lastGoodScrollTop: followLastGoodScrollTopRef.current,
        rawMaxS,
        prevStable,
        followVis: followVisRef.current,
      })
    ) {
      const restore = Math.min(maxS, followLastGoodScrollTopRef.current);
      vp.scrollTop = restore;
      lastScrollTopRef.current = restore;
      followScrollProgrammaticRef.current = true;
      followProgrammaticScrollGuardUntilRef.current = Date.now() + 520;
      followProgrammaticScrollAtRef.current = Date.now();
      fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6bad53" },
        body: JSON.stringify({
          sessionId: "6bad53",
          hypothesisId: "H_SCROLL_TOP_RESTORE",
          location: "Teleprompter.tsx:followViewportRestore",
          message: scrollTopGhostZero && !collapsedLayout ? "ghost scrollTop restore" : "collapse restore",
          data: {
            reason: scrollTopGhostZero && !collapsedLayout ? "ghostZero" : "scrollHeightCollapse",
            restored: restore,
            followVisualChars: followVisRef.current,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      requestAnimationFrame(() => {
        followScrollProgrammaticRef.current = false;
      });
    }
  }, [followMode, isVisible, displayScript, followLayoutSyncKey, followVisualChars, slimMode]);

  useEffect(() => {
    if (!followMode || !displayScript.length) return;
    const t = Date.now();
    if (t - _dwKaraokeLogTs < 400) return;
    _dwKaraokeLogTs = t;
    const pct = followScrollFraction(displayScript, followVisualChars, voskLang);
    // #region agent log
    fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
      body: JSON.stringify({
        sessionId: "dc7a9b",
        location: "TeleprompterOverlay.tsx:karaokePct",
        message: "follow karaoke fraction vs readChars (H_KARAOKE)",
        hypothesisId: "H_KARAOKE",
        data: { followVisualChars, scriptLen: displayScript.length, pct: Math.round(pct * 1000) / 1000 },
        timestamp: t,
      }),
    }).catch(() => {});
    // #endregion
  }, [followMode, followVisualChars, displayScript, voskLang]);

  const draggingRef = useRef(false);
  const resizingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const resizeStartRef = useRef({ width: 0, height: 0, clientX: 0, clientY: 0 });
  const livePosRef = useRef<{ x: number; y: number } | null>(null);
  const lastAnchoredPosRef = useRef<{ x: number; y: number } | null>(null);
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);
  /** Slim bar offset (px) from bottom-center anchor — drag handle moves panel within viewport. */
  const [slimPanelOffset, setSlimPanelOffset] = useState({ x: 0, y: 0 });
  const slimPanelOffsetRef = useRef(slimPanelOffset);
  slimPanelOffsetRef.current = slimPanelOffset;

  useEffect(() => {
    if (!slimMode) setSlimPanelOffset({ x: 0, y: 0 });
  }, [slimMode]);

  const onSlimPanelMovePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY };
      const origin = { ...slimPanelOffsetRef.current };
      const onMove = (ev: PointerEvent) => {
        const vp = getViewportSize();
        const nx = origin.x + (ev.clientX - start.x);
        const ny = origin.y + (ev.clientY - start.y);
        const pad = 4;
        const halfW = vp.width / 2 - pad;
        const halfH = vp.height / 2 - pad;
        setSlimPanelOffset({
          x: Math.max(-halfW, Math.min(halfW, nx)),
          y: Math.max(-halfH, Math.min(halfH, ny)),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [],
  );

  const { viewportRef, scrollContentRef, reset, addScrollDelta, scrollPxRef } = useTeleprompterScroll({
    isVisible: isVisible && !slimMode,
    isPlaying,
    speed,
    script,
    fontSize,
    overlayWidth,
    overlayHeight,
    onSetPlaying,
    resetSignal,
    editorScrollRatio,
  });

  useEffect(() => {
    if (followMode || !isVisible) return;
    const id = requestAnimationFrame(() => {
      const vp = viewportRef.current;
      const pm = vp?.querySelector(".ProseMirror") as HTMLElement | null;
      // #region agent log
      fetch("http://127.0.0.1:7306/ingest/1331bf78-4458-41b9-8b23-f10213f04cd1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "dc7a9b" },
        body: JSON.stringify({
          sessionId: "dc7a9b",
          location: "TeleprompterOverlay.tsx:scrollLayout",
          message: "non-follow viewport vs ProseMirror geometry",
          hypothesisId: "H3",
          data: {
            mode: "scroll",
            vpClientH: vp?.clientHeight ?? -1,
            pmClientH: pm?.clientHeight ?? -1,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    });
    return () => cancelAnimationFrame(id);
  }, [followMode, isVisible, displayScript.length]);

  const scrollDragRef = useRef(false);
  const scrollDragStartRef = useRef(0);
  const [isScrollDragging, setIsScrollDragging] = useState(false);

  const onScrollPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (locked) return;
      e.preventDefault();
      scrollDragRef.current = true;
      setIsScrollDragging(true);
      scrollDragStartRef.current = e.clientY;
      onSetPlaying(false);
      const target = e.currentTarget as HTMLElement;
      if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        if (!scrollDragRef.current) return;
        const delta = scrollDragStartRef.current - ev.clientY;
        scrollDragStartRef.current = ev.clientY;
        addScrollDelta(delta);
      };
      const onUp = () => {
        scrollDragRef.current = false;
        setIsScrollDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [locked, onSetPlaying, addScrollDelta]
  );

  useEffect(() => {
    if (!isVisible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === " ") {
        e.preventDefault();
        if (followMode) return;
        onSetPlaying(!isPlaying);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onNudgeSpeed(8);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onNudgeSpeed(-8);
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (!followMode) reset();
        onReset();
      } else if (e.key.toLowerCase() === "h" || e.key === "Escape") {
        e.preventDefault();
        onHide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isVisible, isPlaying, onSetPlaying, onNudgeSpeed, onReset, onHide, reset, followMode]);

  useEffect(() => {
    if (resetSignal != null) reset();
  }, [resetSignal, reset]);

  const viewport = getViewportSize();
  const baseLeft = (viewport.width - effectiveWidth) / 2;
  const nearCameraLeft = anchorRect
    ? Math.max(12, Math.min(viewport.width - effectiveWidth - 12, anchorRect.left + anchorRect.width / 2 - effectiveWidth / 2))
    : baseLeft;
  const nearCameraTop = anchorRect
    ? Math.max(10, Math.min(viewport.height - effectiveHeight - 20, anchorRect.top + anchorRect.height + 12))
    : 24;
  const dockDefaultLeft = useDock
    ? dockColumnRect!.left + (dockColumnRect!.width - effectiveWidth) / 2
    : null;
  const dockDefaultTop = useDock ? dockColumnRect!.top + 8 : null;
  const defaultLeft =
    useDock && dockDefaultLeft != null ? dockDefaultLeft : nearCamera && anchorRect ? nearCameraLeft : baseLeft;
  const defaultTop =
    useDock && dockDefaultTop != null ? dockDefaultTop : nearCamera && anchorRect ? nearCameraTop : 24;
  const rawLeft = (livePos ?? position)?.x ?? defaultLeft;
  const rawTop = (livePos ?? position)?.y ?? defaultTop;
  const preserved = !anchorRect && lastAnchoredPosRef.current;
  const left = preserved ? lastAnchoredPosRef.current!.x : rawLeft;
  const top = preserved ? lastAnchoredPosRef.current!.y : rawTop;

  useEffect(() => {
    if (anchorRect) {
      lastAnchoredPosRef.current = { x: rawLeft, y: rawTop };
    } else if (lastAnchoredPosRef.current) {
      onPositionChange(lastAnchoredPosRef.current);
      lastAnchoredPosRef.current = null;
    }
  }, [anchorRect, rawLeft, rawTop, onPositionChange]);

  useEffect(() => {
    if (draggingRef.current) return;
    setLivePos(position);
    livePosRef.current = position;
  }, [position]);

  if (!isVisible) return null;

  if (slimMode) {
    /** Same as full overlay / helper readonly doc (see non-slim branch). */
    const slimLineHeight = 1.55;
    const slimFont = fontSize;
    const slimFollowLayoutKey = `${followLayoutSyncKey}-slim`;
    const noDragStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;
    const winDragStyle = { WebkitAppRegion: "drag" } as CSSProperties;
    const moveWindowDragStyle = { WebkitAppRegion: "drag" } as CSSProperties;
    const followStatusShort =
      speechFollow.error != null && speechFollow.error.length > 0
        ? speechFollow.error.slice(0, 48)
        : speechFollow.status != null && speechFollow.status.length > 0
          ? speechFollow.status.slice(0, 48)
          : followMode
            ? "Listening"
            : "Follow off";
    /** Visible window: exactly two lines; content scrolls inside (follow / manual). */
    const slimTwoLineMaxPx = Math.ceil(slimFont * slimLineHeight * 2);

    /** Slim-only Electron window: one surface fills the webview (like Helper). No fixed/portal/floating inner card — avoids a large transparent “box” with a small draggable card inside. */
    if (embeddedInSlimBrowserWindow) {
      return (
        <div
          data-dreamwork-no-intercept
          className="box-border flex h-auto max-h-full w-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[14px] border border-white/30 bg-black/60 text-white shadow-2xl backdrop-blur-sm"
          style={{ opacity }}
        >
          <div
            className="h-5 shrink-0 rounded-t-[10px] border-b border-white/15 bg-white/5"
            style={winDragStyle}
            title="Drag to move window"
          />
          <div
            className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-1 border-b border-white/15 px-1.5 py-1"
            style={noDragStyle}
          >
            <button
              type="button"
              className="shrink-0 rounded border border-white/30 bg-black/40 px-1.5 py-0.5 text-[9px] leading-none text-white/85"
              style={moveWindowDragStyle}
              title="Drag to move window"
            >
              Move
            </button>
            <div className="flex min-w-0 flex-1 flex-row flex-wrap items-center justify-end gap-1">
              {onSetFollowMode && isElectronVosk() && (
                <button
                  type="button"
                  onClick={() => handleTeleprompterFollowToggle(!!followMode, onSetFollowMode)}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] leading-none ${
                    followMode ? "border-emerald-400/70 bg-emerald-600/45 text-white" : "border-white/35 bg-black/35 text-white/95"
                  }`}
                  title={followMode ? "Exit voice follow" : "Voice follow (Vosk)"}
                >
                  {followMode ? "Following" : "Follow"}
                </button>
              )}
              <span
                className="max-w-[6rem] shrink-0 truncate text-[8px] leading-tight text-emerald-100/90"
                title={speechFollow.error || speechFollow.status || followStatusShort}
              >
                {followStatusShort}
              </span>
              {onSetVoskLang && isElectronVosk() && (
                <select
                  value={voskLang}
                  onChange={(e) => onSetVoskLang(e.target.value as TeleprompterVoskLang)}
                  className="max-w-[4.5rem] shrink-0 rounded border border-white/30 bg-black/40 px-0.5 py-0.5 text-[8px] text-white"
                  style={noDragStyle}
                  title="Speech model language"
                >
                  <option value="en">EN</option>
                  <option value="zh">ZH</option>
                  <option value="it">IT</option>
                </select>
              )}
              <button
                type="button"
                className="shrink-0 rounded-full border border-white/35 bg-black/45 px-1.5 py-0.5 text-[9px] leading-none text-white/90"
                onClick={() => onReset()}
                title="Reset scroll and reading position"
              >
                Reset
              </button>
              <button
                type="button"
                className="shrink-0 rounded-full border border-white/35 bg-black/45 px-1.5 py-0.5 text-[9px] leading-none text-white/85"
                onClick={() => onSetSlimMode?.(false)}
                title="Expand teleprompter"
              >
                Expand
              </button>
            </div>
          </div>
          <div
            ref={followContentRef}
            data-follow-viewport=""
            className="min-h-0 shrink-0 overflow-x-hidden overflow-y-auto px-1.5 py-1 text-left text-white [scrollbar-width:thin]"
            style={{ ...noDragStyle, maxHeight: slimTwoLineMaxPx }}
          >
            <div
              className="relative min-h-0 break-words [word-break:break-word]"
              style={{
                fontSize: slimFont,
                lineHeight: slimLineHeight,
              }}
            >
              {displayScript ? (
                <TeleprompterReadonlyDoc
                  ref={followReadonlyDocRef}
                  markdown={displayScript}
                  style={{ fontSize: slimFont, lineHeight: slimLineHeight }}
                  followReadChars={followMode ? followVisualChars : undefined}
                  followSourceLen={displayScript.length}
                  followLang={voskLang}
                  followLayoutSync={slimFollowLayoutKey}
                  followScrollViewportRef={followContentRef}
                  followAutoScroll={followMode}
                  followAutoScrollAllowedRef={followAutoScrollAllowedRef}
                  onFollowScrollProgrammatic={markFollowProgrammaticScroll}
                />
              ) : (
                <span className="block text-white/80" style={{ fontSize: slimFont, lineHeight: slimLineHeight }}>
                  Paste your script in Teleprompter panel.
                </span>
              )}
            </div>
          </div>
        </div>
      );
    }

    /** Main webview / helper: bottom-anchored floating card; Move uses in-viewport offset. */
    const slimBoxStyle: CSSProperties = {
      position: "fixed",
      left: "50%",
      bottom: 12,
      width: "calc(100% - 20px)",
      maxWidth: "min(520px, calc(100vw - 20px))",
      transform: `translate(calc(-50% + ${slimPanelOffset.x}px), ${slimPanelOffset.y}px)`,
      zIndex: 2147483647,
    };
    const slimTree = (
      <div data-dreamwork-no-intercept className="pointer-events-none" style={slimBoxStyle}>
        <div
          className="pointer-events-auto flex min-h-0 max-w-full flex-col overflow-hidden rounded-xl bg-black/60 shadow-xl backdrop-blur-sm ring-1 ring-white/15"
          style={{ opacity }}
        >
          {embeddedInDetachedHelperWindow && (
            <div
              className="h-5 shrink-0 rounded-t-[10px] border-b border-white/15 bg-white/5"
              style={winDragStyle}
              title="Drag to move helper window"
            />
          )}
          <div
            className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-1 border-b border-white/15 px-1.5 py-1"
            style={noDragStyle}
          >
            <button
              type="button"
              className="shrink-0 cursor-grab rounded border border-white/30 bg-black/40 px-1.5 py-0.5 text-[9px] leading-none text-white/85 active:cursor-grabbing"
              style={noDragStyle}
              onPointerDown={onSlimPanelMovePointerDown}
              title="Drag to move this bar on screen"
            >
              Move
            </button>
            <div className="flex min-w-0 flex-1 flex-row flex-wrap items-center justify-end gap-1">
              {onSetFollowMode && isElectronVosk() && (
                <button
                  type="button"
                  onClick={() => handleTeleprompterFollowToggle(!!followMode, onSetFollowMode)}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] leading-none ${
                    followMode ? "border-emerald-400/70 bg-emerald-600/45 text-white" : "border-white/35 bg-black/35 text-white/95"
                  }`}
                  title={followMode ? "Exit voice follow" : "Voice follow (Vosk)"}
                >
                  {followMode ? "Following" : "Follow"}
                </button>
              )}
              <span
                className="max-w-[6rem] shrink-0 truncate text-[8px] leading-tight text-emerald-100/90"
                title={speechFollow.error || speechFollow.status || followStatusShort}
              >
                {followStatusShort}
              </span>
              {embeddedInDetachedHelperWindow && onSetVoskLang && isElectronVosk() && (
                <select
                  value={voskLang}
                  onChange={(e) => onSetVoskLang(e.target.value as TeleprompterVoskLang)}
                  className="max-w-[4.5rem] shrink-0 rounded border border-white/30 bg-black/40 px-0.5 py-0.5 text-[8px] text-white"
                  style={noDragStyle}
                  title="Speech model language"
                >
                  <option value="en">EN</option>
                  <option value="zh">ZH</option>
                  <option value="it">IT</option>
                </select>
              )}
              <button
                type="button"
                className="shrink-0 rounded-full border border-white/35 bg-black/45 px-1.5 py-0.5 text-[9px] leading-none text-white/90"
                onClick={() => onReset()}
                title="Reset scroll and reading position"
              >
                Reset
              </button>
              <button
                type="button"
                className="shrink-0 rounded-full border border-white/35 bg-black/45 px-1.5 py-0.5 text-[9px] leading-none text-white/85"
                onClick={() => onSetSlimMode?.(false)}
                title="Expand teleprompter"
              >
                Expand
              </button>
            </div>
          </div>
          <div
            ref={followContentRef}
            data-follow-viewport=""
            className="min-h-0 w-full overflow-x-hidden overflow-y-auto px-1.5 py-1 text-left text-white [scrollbar-width:thin]"
            style={{ ...noDragStyle, maxHeight: slimTwoLineMaxPx }}
          >
            <div
              className="relative min-h-0 break-words [word-break:break-word]"
              style={{
                fontSize: slimFont,
                lineHeight: slimLineHeight,
              }}
            >
              {displayScript ? (
                <TeleprompterReadonlyDoc
                  ref={followReadonlyDocRef}
                  markdown={displayScript}
                  style={{ fontSize: slimFont, lineHeight: slimLineHeight }}
                  followReadChars={followMode ? followVisualChars : undefined}
                  followSourceLen={displayScript.length}
                  followLang={voskLang}
                  followLayoutSync={slimFollowLayoutKey}
                  followScrollViewportRef={followContentRef}
                  followAutoScroll={followMode}
                  followAutoScrollAllowedRef={followAutoScrollAllowedRef}
                  onFollowScrollProgrammatic={markFollowProgrammaticScroll}
                />
              ) : (
                <span className="block text-white/80" style={{ fontSize: slimFont, lineHeight: slimLineHeight }}>
                  Paste your script in Teleprompter panel.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
    if (embeddedInDetachedHelperWindow && typeof document !== "undefined") {
      return createPortal(slimTree, document.body);
    }
    return slimTree;
  }

  const onDragPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    draggingRef.current = true;
    onDragStart();
    const start = livePosRef.current ?? position ?? { x: defaultLeft, y: defaultTop };
    setLivePos(start);
    livePosRef.current = start;
    dragOffsetRef.current = { x: e.clientX - start.x, y: e.clientY - start.y };
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const vp = getViewportSize();
      let minL = 8;
      let maxL = vp.width - effectiveWidth - 8;
      let minT = 8;
      let maxT = vp.height - effectiveHeight - 8;
      if (useDock && dockColumnRect) {
        const r = dockColumnRect;
        const colRight = r.left + r.width;
        const colBottom = r.top + r.height;
        minL = r.left + 8;
        maxL = colRight - effectiveWidth - 8;
        minT = r.top + 8;
        maxT = colBottom - effectiveHeight - 8;
      }
      const x = Math.max(minL, Math.min(maxL, ev.clientX - dragOffsetRef.current.x));
      const y = Math.max(minT, Math.min(maxT, ev.clientY - dragOffsetRef.current.y));
      const next = { x, y };
      livePosRef.current = next;
      setLivePos(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      if (livePosRef.current) onPositionChange(livePosRef.current);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    resizeStartRef.current = {
      width: effectiveWidth,
      height: effectiveHeight,
      clientX: e.clientX,
      clientY: e.clientY,
    };
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      const { width, height, clientX, clientY } = resizeStartRef.current;
      const dx = ev.clientX - clientX;
      const dy = ev.clientY - clientY;
      const vp = getViewportSize();
      const maxW = useDock && dockColumnRect ? dockColumnRect.width - 16 : vp.width - left - 16;
      const maxH = useDock && dockColumnRect ? dockColumnRect.height - 16 : vp.height - top - 16;
      const newWidth = Math.max(320, Math.min(900, Math.min(maxW, width + dx)));
      const newHeight = Math.max(180, Math.min(500, Math.min(maxH, height + dy)));
      onOverlaySizeChange(newWidth, newHeight);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const scrollClip = embeddedInDetachedHelperWindow ? "inset(0)" : "inset(32px 0 0 0)";

  return (
    <div
      data-dreamwork-no-intercept
      className={
        embeddedInDetachedHelperWindow
          ? "relative z-0 flex max-h-full max-w-full shrink-0 flex-col overflow-hidden rounded-xl border border-white/30 bg-black/60 shadow-2xl backdrop-blur-sm"
          : "!fixed z-[1000000] overflow-hidden rounded-xl border border-white/30 bg-black/60 shadow-2xl backdrop-blur-sm"
      }
      style={
        embeddedInDetachedHelperWindow
          ? {
              width: "100%",
              height: "100%",
              minWidth: 0,
              minHeight: 0,
              maxWidth: "100%",
              maxHeight: "100%",
              opacity,
            }
          : {
              width: effectiveWidth,
              maxWidth: useDock ? effectiveWidth : "calc(100vw - 24px)",
              height: effectiveHeight,
              left,
              top,
              opacity,
            }
      }
      aria-hidden
    >
      {!embeddedInDetachedHelperWindow && (
        <div
          className={`absolute inset-x-0 top-0 z-20 h-8 border-b border-white/20 bg-black/30 ${locked ? "cursor-not-allowed" : "cursor-grab"}`}
          onPointerDown={onDragPointerDown}
        />
      )}
      <button
        type="button"
        onClick={onToggleLocked}
        className="absolute right-2 top-1.5 z-30 rounded border border-white/30 bg-black/50 px-1.5 py-0.5 text-[10px] text-white/90"
        title={locked ? "Unlock teleprompter drag" : "Lock teleprompter position"}
      >
        {locked ? "Locked" : "Lock"}
      </button>
      <div className="absolute left-2 top-1.5 z-30 flex max-w-[calc(100%-4rem)] flex-wrap items-center gap-1">
        {onSetFollowMode && isElectronVosk() && (
          <button
            type="button"
            onClick={() => handleTeleprompterFollowToggle(!!followMode, onSetFollowMode)}
            className={`rounded border px-1.5 py-0.5 text-[10px] ${followMode ? "border-emerald-400/60 bg-emerald-600/50 text-white" : "border-white/30 bg-black/50 text-white/90"}`}
            title={followMode ? "Exit voice follow" : "Voice follow (Vosk — desktop app)"}
          >
            {followMode ? "Following" : "Follow"}
          </button>
        )}
        {embeddedInDetachedHelperWindow && onSetVoskLang && isElectronVosk() && (
          <label className="flex min-w-0 items-center gap-0.5 text-[9px] text-white/75">
            <span className="shrink-0">Model</span>
            <select
              value={voskLang}
              onChange={(e) => onSetVoskLang(e.target.value as TeleprompterVoskLang)}
              className="max-w-[120px] rounded border border-white/25 bg-black/55 px-1 py-0.5 text-[9px] text-white"
              title="Must match how you speak."
            >
              <option value="en">English (EN)</option>
              <option value="zh">中英混稿 (ZH)</option>
              <option value="it">Italiano (IT)</option>
            </select>
          </label>
        )}
        {onSetSlimMode && (
          <button
            type="button"
            onClick={() => onSetSlimMode(true)}
            className="rounded border border-white/30 bg-black/50 px-1.5 py-0.5 text-[10px] text-white/90"
            title="Slim bar mode (passthrough clicks)"
          >
            Slim
          </button>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/80 to-transparent" />
      {followMode ? (
        <div className="relative h-full min-h-0 overflow-hidden">
          <div
            ref={followContentRef}
            data-follow-viewport=""
            className="relative z-0 h-full overflow-y-auto px-6 py-7 text-center text-white"
          >
            <div
              ref={followInnerRef}
              className="relative text-center"
              style={{
                fontSize,
                paddingTop: "1em",
                paddingBottom: "80%",
              }}
            >
              {displayScript ? (
                <TeleprompterReadonlyDoc
                  ref={followReadonlyDocRef}
                  markdown={displayScript}
                  style={{ fontSize, lineHeight: 1.55 }}
                  followReadChars={followVisualChars}
                  followSourceLen={displayScript.length}
                  followLang={voskLang}
                  followLayoutSync={followLayoutSyncKey}
                  followScrollViewportRef={followContentRef}
                  followAutoScroll
                  followAutoScrollAllowedRef={followAutoScrollAllowedRef}
                  onFollowScrollProgrammatic={markFollowProgrammaticScroll}
                />
              ) : (
                <span className="block w-full text-center" style={{ fontSize, lineHeight: 1.55 }}>
                  Paste your script in Teleprompter panel.
                </span>
              )}
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-2 inset-x-0 z-20 flex flex-col items-center justify-center gap-1 px-2">
            <span className="rounded-full bg-black/60 px-3 py-1 text-[10px] text-emerald-200/80 backdrop-blur-sm">
              {speechFollow.error ? speechFollow.error.slice(0, 120) : speechFollow.status || "Voice follow"}
            </span>
          </div>
        </div>
      ) : (
        <div
          ref={viewportRef}
          className={`relative h-full overflow-hidden px-6 py-7 text-center text-white ${isScrollDragging ? "cursor-grabbing" : "cursor-grab"}`}
          style={{ clipPath: scrollClip }}
          onPointerDown={onScrollPointerDown}
          title="Drag to scroll"
        >
          <div
            ref={scrollContentRef}
            className="text-center"
            style={{ fontSize, lineHeight: 1.55, willChange: "transform" }}
          >
            <div style={{ paddingTop: "1em", paddingBottom: "80%" }}>
              {displayScript ? (
                <TeleprompterReadonlyDoc
                  markdown={displayScript}
                  style={{ fontSize, lineHeight: 1.55 }}
                  followLang={voskLang}
                />
              ) : (
                <span className="block w-full">Paste your script in Teleprompter panel.</span>
              )}
            </div>
          </div>
          {isPlaying && displayScript && (
            <div className="pointer-events-none absolute bottom-2 right-3 z-20 flex flex-col items-end gap-1">
              <span className="rounded-full bg-black/60 px-2.5 py-0.5 text-[10px] tabular-nums text-white/50 backdrop-blur-sm">
                {Math.round(speed)} px/s
              </span>
              {speed > 0 && (() => {
                const el = viewportRef.current;
                const maxScroll = el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
                const remaining = Math.max(0, maxScroll - scrollPxRef.current);
                const secs = remaining / speed;
                if (secs <= 0 || secs > 9999) return null;
                const mins = Math.floor(secs / 60);
                const secsLeft = Math.round(secs % 60);
                return (
                  <span className="rounded-full bg-black/60 px-2.5 py-0.5 text-[10px] tabular-nums text-white/40 backdrop-blur-sm">
                    ~{mins > 0 ? `${mins}m ` : ""}{secsLeft}s left
                  </span>
                );
              })()}
            </div>
          )}
        </div>
      )}
      {!embeddedInDetachedHelperWindow && (
        <div
          role="button"
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          className={`absolute bottom-0 right-0 z-30 h-[18px] w-[18px] cursor-se-resize rounded-br-xl ${locked ? "pointer-events-none opacity-40" : "hover:bg-white/[0.06]"}`}
          style={{
            background:
              "linear-gradient(to top left, rgba(255,255,255,.28) 0%, rgba(255,255,255,.28) 42%, transparent 42.5%)",
          }}
          title="Drag to resize"
          aria-label="Resize overlay"
        />
      )}
    </div>
  );
});

export function TeleprompterPanel({
  isVisible,
  isPlaying,
  script,
  scripts,
  activeScriptId,
  onSwitchScript,
  onNewScript,
  onImportScripts,
  onSaveAsScript,
  onRenameScript,
  speed,
  fontSize,
  opacity,
  overlayWidth,
  nearCamera,
  locked,
  position,
  panelWidth,
  panelHeight,
  onPanelSizeChange,
  onSetScript,
  onSetPlaying,
  onSetSpeed,
  onSetFontSize,
  onSetOpacity,
  onSetOverlayWidth,
  onSetNearCamera,
  onPositionChange,
  onToggleLocked,
  onReset,
  onHide,
  onFlushSave,
  onEditorScroll,
  followMode,
  onSetFollowMode,
  voskLang = "en",
  onSetVoskLang,
}: TeleprompterPanelProps) {
  const MIN_PANEL_HEIGHT = 320;
  const MIN_EDITOR_HEIGHT = 96;
  const PANEL_CHROME_RESERVED = 190;
  const [collapsed, setCollapsed] = useState(false);
  const [editingScriptName, setEditingScriptName] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const saveAsRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const scriptEditorRef = useRef<TeleprompterScriptEditorHandle>(null);
  const scrollTopByScriptRef = useRef<Record<string, number>>({});
  const prevActiveScriptIdRef = useRef(activeScriptId);
  const currentScript = scripts.find((s) => s.id === activeScriptId);
  /** Local draft: avoid lifting every keystroke to App (heavy re-renders + settings effect). */
  const [draftScript, setDraftScript] = useState(script);

  /** Keep editor in sync with App; refresh when switching scripts or importing. If only `script` changes while the user is typing, skip overwrite. */
  useEffect(() => {
    const switchedScript = prevActiveScriptIdRef.current !== activeScriptId;
    prevActiveScriptIdRef.current = activeScriptId;
    if (switchedScript) {
      setDraftScript(script);
      return;
    }
    const wrap = panelRef.current?.querySelector("[data-teleprompter-editor]") as HTMLElement | null;
    const focused = wrap && (wrap === document.activeElement || wrap.contains(document.activeElement));
    if (focused) return;
    setDraftScript(script);
  }, [activeScriptId, script]);

  /** Whiteboard ⌘S runs before React state catches editor debounce — sync draft into settings snapshot first. */
  useEffect(() => {
    const onFlushDraft = () => {
      const v = scriptEditorRef.current?.getMarkdown() ?? draftScript;
      setDraftScript(v);
      onSetScript(v);
      onFlushSave?.(v);
    };
    window.addEventListener(DREAMWORK_FLUSH_TELEPROMPTER_DRAFT, onFlushDraft);
    return () => window.removeEventListener(DREAMWORK_FLUSH_TELEPROMPTER_DRAFT, onFlushDraft);
  }, [draftScript, onSetScript, onFlushSave]);

  const downloadScript = useCallback(
    (ext: "md" | "txt") => {
      const content = draftScript;
      const name = (currentScript?.name ?? "script").replace(/[<>:"/\\|?*]/g, "_");
      const filename = `${name}.${ext}`;
      const mime = ext === "md" ? "text/markdown" : "text/plain";
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setSaveAsOpen(false);
    },
    [draftScript, currentScript?.name]
  );

  const flushDraftToParent = useCallback(() => {
    const v = scriptEditorRef.current?.getMarkdown() ?? draftScript;
    onSetScript(v);
  }, [draftScript, onSetScript]);

  const handleEditorScroll = useCallback(
    (ratio: number) => {
      const wrap = panelRef.current?.querySelector("[data-teleprompter-editor]") as HTMLElement | null;
      if (wrap) scrollTopByScriptRef.current[activeScriptId] = wrap.scrollTop;
      onEditorScroll?.(ratio);
      onSetPlaying(false);
    },
    [activeScriptId, onEditorScroll, onSetPlaying]
  );

  const runImportItems = useCallback(
    (items: { name: string; content: string }[]) => {
      if (!items.length) return;
      setDraftScript(normalizeTeleprompterImportedText(items[items.length - 1]!.content));
      onImportScripts(items);
    },
    [onImportScripts]
  );

  const handleImportClick = useCallback(async () => {
    flushDraftToParent();
    const openTextFiles = (
      typeof window !== "undefined"
        ? (
            window as unknown as {
              electronAPI?: {
                openTextFiles?: (opts?: { multi?: boolean }) => Promise<{
                  ok: boolean;
                  files: { name: string; content: string }[];
                }>;
              };
            }
          ).electronAPI?.openTextFiles
        : undefined
    );
    if (typeof openTextFiles === "function") {
      try {
        const res = await openTextFiles({ multi: true });
        if (res?.ok && res.files?.length) {
          const items = res.files.map((f) => ({
            name: teleprompterNameFromFilename(f.name),
            content: f.content,
          }));
          runImportItems(items);
          return;
        }
      } catch {
        /* fall through to hidden file input */
      }
    }
    importInputRef.current?.click();
  }, [flushDraftToParent, runImportItems]);

  useEffect(() => {
    if (!saveAsOpen) return;
    const close = (e: MouseEvent) => {
      if (saveAsRef.current && !saveAsRef.current.contains(e.target as Node)) setSaveAsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [saveAsOpen]);
  const autoMinimizeTimerRef = useRef<number | null>(null);
  /** True while the pointer is over the expanded main panel; auto-mini only arms after pointerleave. */
  const pointerInsidePanelRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const collapsedRef = useRef(false);
  const draggingRef = useRef(false);
  const lastPointerDuringDragRef = useRef({ x: 0, y: 0 });
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const panelLivePosRef = useRef<{ x: number; y: number } | null>(null);
  const [panelLivePos, setPanelLivePos] = useState<{ x: number; y: number } | null>(null);
  const [panelSize, setPanelSize] = useState({ w: panelWidth, h: panelHeight });
  const [editorHeight, setEditorHeight] = useState(() => Math.max(140, panelHeight - PANEL_CHROME_RESERVED));
  const panelSizeRef = useRef(panelSize);
  panelSizeRef.current = panelSize;
  const editorHeightRef = useRef(editorHeight);
  editorHeightRef.current = editorHeight;
  const panelResizingRef = useRef(false);
  const editorResizingRef = useRef(false);

  useEffect(() => {
    setPanelSize({ w: panelWidth, h: panelHeight });
  }, [panelWidth, panelHeight]);

  useEffect(() => {
    const maxEditorHeight = Math.max(MIN_EDITOR_HEIGHT, panelSize.h - PANEL_CHROME_RESERVED);
    if (editorHeightRef.current > maxEditorHeight) {
      setEditorHeight(maxEditorHeight);
      return;
    }
    if (editorHeightRef.current < MIN_EDITOR_HEIGHT) {
      setEditorHeight(MIN_EDITOR_HEIGHT);
    }
  }, [panelSize.h]);

  const expandedWidth = panelSize.w;
  const expandedHeight = panelSize.h;
  const collapsedWidth = 440;
  const collapsedHeight = 44;
  const viewport = getViewportSize();

  const defaultPos = {
    x: Math.max(8, viewport.width - expandedWidth - 16),
    y: Math.max(8, viewport.height - expandedHeight - 16),
  };
  const left = (panelLivePos ?? position)?.x ?? defaultPos.x;
  const top = (panelLivePos ?? position)?.y ?? defaultPos.y;

  useEffect(() => {
    if (draggingRef.current) return;
    setPanelLivePos(position);
    panelLivePosRef.current = position;
  }, [position]);

  const AUTO_MINIMIZE_MS = 3000;

  const clearAutoMinimizeTimer = useCallback(() => {
    if (autoMinimizeTimerRef.current != null) {
      window.clearTimeout(autoMinimizeTimerRef.current);
      autoMinimizeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    collapsedRef.current = collapsed;
    if (collapsed) pointerInsidePanelRef.current = false;
  }, [collapsed]);

  /** 指针离开主面板且 3s 内未再回到面板内（或未保持焦点在内）则收起为 Mini。 */
  const scheduleEditIdleCollapse = useCallback(() => {
    if (collapsedRef.current || draggingRef.current) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (pointerInsidePanelRef.current) return;
    if (panel.contains(document.activeElement)) return;
    clearAutoMinimizeTimer();
    autoMinimizeTimerRef.current = window.setTimeout(() => {
      const p = panelRef.current;
      if (!p || collapsedRef.current) return;
      if (pointerInsidePanelRef.current) return;
      if (p.contains(document.activeElement)) return;
      setCollapsed(true);
    }, AUTO_MINIMIZE_MS);
  }, [clearAutoMinimizeTimer]);

  /** 指针在面板外编辑时重置「离开空闲」计时；指针在面板内由 pointerenter 负责不清计时。 */
  const bumpEditActivity = useCallback(() => {
    if (pointerInsidePanelRef.current) return;
    scheduleEditIdleCollapse();
  }, [scheduleEditIdleCollapse]);

  useEffect(() => {
    if (!isVisible) return;
    setCollapsed(false);
    pointerInsidePanelRef.current = false;
    clearAutoMinimizeTimer();
    return clearAutoMinimizeTimer;
  }, [isVisible, clearAutoMinimizeTimer]);

  /** Expanded panel: focus 离开到面板外时，与 pointerleave 一样启动空闲收起计时。 */
  useEffect(() => {
    if (!isVisible || collapsed) return;
    const el = panelRef.current;
    if (!el) return;
    const onFocusIn = () => clearAutoMinimizeTimer();
    const onFocusOut = (e: FocusEvent) => {
      const rt = e.relatedTarget as Node | null;
      if (rt && el.contains(rt)) return;
      requestAnimationFrame(() => {
        if (!panelRef.current || collapsedRef.current) return;
        if (pointerInsidePanelRef.current) return;
        if (panelRef.current.contains(document.activeElement)) return;
        scheduleEditIdleCollapse();
      });
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, [isVisible, collapsed, clearAutoMinimizeTimer, scheduleEditIdleCollapse]);

  const onExpandedPanelPointerEnter = useCallback(() => {
    pointerInsidePanelRef.current = true;
    clearAutoMinimizeTimer();
  }, [clearAutoMinimizeTimer]);

  const onExpandedPanelPointerLeave = useCallback(() => {
    pointerInsidePanelRef.current = false;
    if (!collapsedRef.current && !draggingRef.current) scheduleEditIdleCollapse();
  }, [scheduleEditIdleCollapse]);

  // Restore editor scroll position when panel expands (e.g. after returning from whiteboard)
  useEffect(() => {
    if (!collapsed && panelRef.current) {
      const el = panelRef.current.querySelector("[data-teleprompter-editor]") as HTMLElement | null;
      if (!el) return;
      const saved = scrollTopByScriptRef.current[activeScriptId] ?? 0;
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll > 0) {
        requestAnimationFrame(() => {
          el.scrollTop = Math.min(saved, maxScroll);
        });
      }
    }
  }, [collapsed, activeScriptId]);

  const onPanelDragDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    const panelEl = panelRef.current;
    if (!panelEl) return;
    e.preventDefault();
    if (!collapsed) clearAutoMinimizeTimer();
    lastPointerDuringDragRef.current = { x: e.clientX, y: e.clientY };
    const rect = panelEl.getBoundingClientRect();
    draggingRef.current = true;
    const start = panelLivePosRef.current ?? position ?? { x: rect.left, y: rect.top };
    setPanelLivePos(start);
    panelLivePosRef.current = start;
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      lastPointerDuringDragRef.current = { x: ev.clientX, y: ev.clientY };
      const width = collapsed ? collapsedWidth : panelSizeRef.current.w;
      const height = collapsed ? collapsedHeight : panelSizeRef.current.h;
      const vp = getViewportSize();
      const x = Math.max(8, Math.min(vp.width - width - 8, ev.clientX - dragOffsetRef.current.x));
      const y = Math.max(8, Math.min(vp.height - height - 8, ev.clientY - dragOffsetRef.current.y));
      const next = { x, y };
      panelLivePosRef.current = next;
      setPanelLivePos(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      if (panelLivePosRef.current) onPositionChange(panelLivePosRef.current);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!collapsedRef.current) scheduleEditIdleCollapse();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onPanelChromePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, a, input, select, textarea")) return;
    onPanelDragDown(e);
  };

  const onPanelResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    clearAutoMinimizeTimer();
    const anchor = panelLivePosRef.current ?? position ?? { x: left, y: top };
    panelLivePosRef.current = anchor;
    setPanelLivePos(anchor);
    panelResizingRef.current = true;
    const startW = panelSizeRef.current.w;
    const startH = panelSizeRef.current.h;
    const sx = e.clientX;
    const sy = e.clientY;
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);
    let lastW = startW;
    let lastH = startH;
    const onMove = (ev: PointerEvent) => {
      if (!panelResizingRef.current) return;
      const vp = getViewportSize();
      const maxW = Math.min(920, vp.width - 16);
      const maxH = Math.min(900, vp.height - 16);
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      lastW = Math.max(280, Math.min(maxW, startW + dx));
      lastH = Math.max(MIN_PANEL_HEIGHT, Math.min(maxH, startH + dy));
      setPanelSize({ w: lastW, h: lastH });
    };
    const onUp = () => {
      panelResizingRef.current = false;
      onPanelSizeChange(lastW, lastH);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!collapsedRef.current) scheduleEditIdleCollapse();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onEditorResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    clearAutoMinimizeTimer();
    const anchor = panelLivePosRef.current ?? position ?? { x: left, y: top };
    panelLivePosRef.current = anchor;
    setPanelLivePos(anchor);
    editorResizingRef.current = true;
    const startPanelH = panelSizeRef.current.h;
    const startEditorH = editorHeightRef.current;
    const sy = e.clientY;
    let lastPanelH = startPanelH;
    let lastEditorH = startEditorH;
    const target = e.currentTarget as HTMLElement;
    if (target.setPointerCapture && e.pointerId != null) target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!editorResizingRef.current) return;
      const vp = getViewportSize();
      const maxPanelByViewport = Math.min(900, Math.max(MIN_PANEL_HEIGHT, vp.height - top - 8));
      const dy = ev.clientY - sy;
      const nextPanelH = Math.max(MIN_PANEL_HEIGHT, Math.min(maxPanelByViewport, startPanelH + dy));
      const panelDelta = nextPanelH - startPanelH;
      const nextEditorMax = Math.max(MIN_EDITOR_HEIGHT, nextPanelH - PANEL_CHROME_RESERVED);
      const nextEditorH = Math.max(MIN_EDITOR_HEIGHT, Math.min(nextEditorMax, startEditorH + panelDelta));
      lastPanelH = nextPanelH;
      lastEditorH = nextEditorH;
      setPanelSize((prev) => ({ ...prev, h: nextPanelH }));
      setEditorHeight(nextEditorH);
    };

    const onUp = () => {
      editorResizingRef.current = false;
      setEditorHeight(lastEditorH);
      onPanelSizeChange(panelSizeRef.current.w, lastPanelH);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!collapsedRef.current) scheduleEditIdleCollapse();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  if (!isVisible) return null;

  /** Same height / radius / horizontal padding as GlassButton `sm` overrides (h-7, rounded-lg, px-2). */
  const tpActionClass =
    "!h-7 min-h-0 shrink-0 !px-2 !py-0 !text-[10px] font-normal leading-tight !text-white";
  const tpSelectClass =
    "box-border h-7 min-w-0 flex-1 rounded-lg border border-white/20 bg-black/45 px-2 py-0 text-[10px] font-normal leading-7 text-white outline-none [color-scheme:dark]";

  const collapsedVp = getViewportSize();
  const collapsedClampedLeft = Math.max(
    8,
    Math.min(left, collapsedVp.width - collapsedWidth - 8),
  );
  const collapsedClampedTop = Math.max(
    8,
    Math.min(top, collapsedVp.height - collapsedHeight - 8),
  );

  const panelEl = collapsed ? (
    <div
      ref={panelRef}
      data-dreamwork-no-intercept
      className={`!fixed z-[1000000] flex h-11 items-center gap-1.5 whitespace-nowrap rounded-xl border border-white/30 bg-black/75 px-2 text-xs text-white shadow-2xl backdrop-blur-md [color-scheme:dark] ${locked ? "" : "cursor-grab"}`}
      style={{ left: collapsedClampedLeft, top: collapsedClampedTop }}
      onPointerDown={onPanelChromePointerDown}
    >
      <div
        className={`shrink-0 select-none rounded border border-white/25 bg-black/45 px-0.5 text-center text-[10px] leading-7 text-white/70 ${locked ? "cursor-not-allowed opacity-60" : "cursor-grab active:cursor-grabbing"}`}
        aria-hidden
        title="Drag to move"
      >
        ⋮⋮
      </div>
      <span className="shrink-0 select-none text-[11px] text-white/80">Teleprompter</span>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px] text-white"
          onClick={() => onSetPlaying(!isPlaying)}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        {onSetFollowMode && isElectronVosk() && (
          <button
            type="button"
            className={`rounded border px-2 py-1 text-[10px] ${followMode ? "border-emerald-400/60 bg-emerald-600/50 text-white" : "border-white/30 bg-black/45 text-white"}`}
            onClick={() => handleTeleprompterFollowToggle(!!followMode, onSetFollowMode)}
            title={followMode ? "Exit voice follow" : "Voice follow (Vosk)"}
          >
            {followMode ? "Following" : "Follow"}
          </button>
        )}
        <button
          type="button"
          className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px] text-white"
          onClick={() => onReset()}
          title="Reset scroll and reading position"
        >
          Reset
        </button>
        <button
          type="button"
          className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px] text-white"
          onClick={() => {
            setCollapsed(false);
            clearAutoMinimizeTimer();
          }}
        >
          Open
        </button>
        <button
          type="button"
          className="rounded border border-white/30 bg-black/45 px-2 py-1 text-[10px] text-white"
          onClick={() => {
            flushDraftToParent();
            onHide();
          }}
        >
          Hide
        </button>
      </div>
    </div>
  ) : (
    <div
      ref={panelRef}
      data-dreamwork-no-intercept
      className="!fixed z-[1000000] box-border flex max-h-[calc(100vh-16px)] min-h-0 flex-col overflow-hidden rounded-xl border border-white/30 bg-black/70 p-2.5 text-[11px] text-white shadow-2xl backdrop-blur-md [color-scheme:dark]"
      style={{
        left,
        top,
        width: panelSize.w,
        height: panelSize.h,
        maxWidth: "min(920px, calc(100vw - 16px))",
      }}
      onPointerEnter={onExpandedPanelPointerEnter}
      onPointerLeave={onExpandedPanelPointerLeave}
    >
      {/* Fixed chrome — drag from title row (not only ::); Lock stays clickable */}
      <div
        className={`mb-1.5 flex shrink-0 items-center gap-2 ${locked ? "" : "cursor-grab"}`}
        onPointerDown={onPanelChromePointerDown}
      >
        <div
          className={`shrink-0 select-none rounded border border-white/25 bg-black/45 px-0.5 text-center text-[10px] leading-6 text-white/70 ${locked ? "cursor-not-allowed opacity-60" : "cursor-grab active:cursor-grabbing"}`}
          aria-hidden
          title="Drag to move"
        >
          ⋮⋮
        </div>
        <span className="mr-auto select-none text-[12px] font-semibold">Teleprompter</span>
        <button
          type="button"
          onClick={onToggleLocked}
          className="shrink-0 rounded border border-white/30 bg-black/45 px-1.5 py-0.5 text-[10px] text-white"
          title={locked ? "Unlock teleprompter drag" : "Lock teleprompter position"}
        >
          {locked ? "Locked" : "Lock"}
        </button>
      </div>
      <div className="mb-1.5 flex w-full min-w-0 shrink-0 flex-wrap gap-1">
        <GlassButton
          size="sm"
          className={tpActionClass}
          variant={isPlaying ? "primary" : "secondary"}
          onClick={() => onSetPlaying(!isPlaying)}
        >
          {isPlaying ? "Pause" : "Play"}
        </GlassButton>
        <GlassButton size="sm" className={tpActionClass} variant="secondary" onClick={onReset}>
          Reset
        </GlassButton>
        <GlassButton
          size="sm"
          className={tpActionClass}
          variant="secondary"
          onClick={() => {
            clearAutoMinimizeTimer();
            setCollapsed(true);
          }}
        >
          Min
        </GlassButton>
        <GlassButton
          size="sm"
          className={tpActionClass}
          variant="ghost"
          onClick={() => {
            flushDraftToParent();
            onHide();
          }}
        >
          Hide
        </GlassButton>
      </div>
      {isElectronVosk() && onSetFollowMode && onSetVoskLang && (
        <div className="mb-2 flex w-full min-w-0 shrink-0 flex-wrap items-center gap-1.5">
          <GlassButton
            size="sm"
            className={tpActionClass}
            variant={followMode ? "primary" : "secondary"}
            onClick={() => handleTeleprompterFollowToggle(!!followMode, onSetFollowMode)}
            title="Follow uses the model language: pick 中英混稿 (ZH) for Chinese speech, English (EN) for English."
          >
            {followMode ? "Following" : "Voice follow"}
          </GlassButton>
          <label className="flex min-w-0 items-center gap-1 text-[10px] text-white/70">
            <span className="shrink-0">Model</span>
            <select
              value={voskLang}
              onChange={(e) => onSetVoskLang(e.target.value as TeleprompterVoskLang)}
              className={tpSelectClass}
              title="Must match how you speak: zh = Chinese (and mixed CN/EN script), en = English, it = Italian."
            >
              <option value="en">English (EN)</option>
              <option value="zh">中英混稿 (ZH)</option>
              <option value="it">Italiano (IT)</option>
            </select>
          </label>
        </div>
      )}
      <div className="mb-2 flex w-full min-w-0 shrink-0 flex-wrap items-center gap-1">
        {editingScriptName ? (
          <input
            type="text"
            defaultValue={currentScript?.name ?? "Untitled"}
            className={tpSelectClass}
            autoFocus
            onBlur={(e) => {
              const name = e.target.value.trim() || (currentScript?.name ?? "Untitled");
              onRenameScript(name);
              setEditingScriptName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const name = e.currentTarget.value.trim() || (currentScript?.name ?? "Untitled");
                onRenameScript(name);
                setEditingScriptName(false);
              }
              if (e.key === "Escape") setEditingScriptName(false);
            }}
          />
        ) : (
          <select
            value={activeScriptId}
            onChange={(e) => {
              flushDraftToParent();
              onSwitchScript(e.target.value);
            }}
            className={tpSelectClass}
          >
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <GlassButton
          size="sm"
          className={tpActionClass}
          variant="secondary"
          onClick={() => {
            flushDraftToParent();
            onNewScript();
          }}
          title="New script"
        >
          New
        </GlassButton>
        <input
          ref={importInputRef}
          type="file"
          accept="text/plain,text/markdown,.txt,.md,.markdown,.script,*/*"
          multiple
          className="sr-only h-px w-px overflow-hidden border-0 p-0 opacity-0"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const inputEl = e.target;
            const list = inputEl.files;
            if (!list?.length) return;
            flushDraftToParent();
            void (async () => {
              const items: { name: string; content: string }[] = [];
              for (const f of Array.from(list)) {
                try {
                  items.push({ name: teleprompterNameFromFilename(f.name), content: await f.text() });
                } catch {
                  /* unreadable file — skip */
                }
              }
              inputEl.value = "";
              runImportItems(items);
            })();
          }}
        />
        <GlassButton
          type="button"
          size="sm"
          className={tpActionClass}
          variant="secondary"
          onClick={() => void handleImportClick()}
          title="Import .txt, .md, or .script from disk (multiple files allowed)"
        >
          Import
        </GlassButton>
        <div ref={saveAsRef} className="relative shrink-0">
          <GlassButton
            size="sm"
            className={`${tpActionClass} whitespace-nowrap`}
            variant="secondary"
            onClick={() => setSaveAsOpen((o) => !o)}
            title="Save as new script or export to file"
          >
            Save as
          </GlassButton>
          {saveAsOpen && (
            <div
              className="absolute left-0 top-full z-50 mt-1 min-w-[148px] rounded border border-white/20 bg-black/90 py-0.5 shadow-xl"
              data-dreamwork-no-intercept
            >
              <button
                type="button"
                className="block w-full px-2.5 py-1 text-left text-[10px] text-white hover:bg-white/15"
                onClick={() => {
                  setSaveAsOpen(false);
                  flushDraftToParent();
                  onSaveAsScript();
                }}
              >
                Save as new script
              </button>
              <button
                type="button"
                className="block w-full px-2.5 py-1 text-left text-[10px] text-white hover:bg-white/15"
                onClick={() => downloadScript("md")}
              >
                Download as .md
              </button>
              <button
                type="button"
                className="block w-full px-2.5 py-1 text-left text-[10px] text-white hover:bg-white/15"
                onClick={() => downloadScript("txt")}
              >
                Download as .txt
              </button>
            </div>
          )}
        </div>
        <GlassButton
          size="sm"
          className={`${tpActionClass} whitespace-nowrap`}
          variant="secondary"
          onClick={() => setEditingScriptName(true)}
          title="Rename script"
        >
          Rename
        </GlassButton>
      </div>

      {/* Scroll body: stack is non-overlapping; short panels scroll as one column (auto-layout safe) */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <TeleprompterScriptEditor
          ref={scriptEditorRef}
          value={draftScript}
          activeScriptId={activeScriptId}
          height={editorHeight}
          placeholder="Paste script here…"
          className={TELEPROMPTER_EDITOR_HTML_CLASS}
          onChange={(v) => {
            setDraftScript(v);
            bumpEditActivity();
          }}
          onDebouncedCommit={onSetScript}
          debounceMs={120}
          onScroll={handleEditorScroll}
          onBlurCommit={() => {
            const v = scriptEditorRef.current?.getMarkdown() ?? draftScript;
            setDraftScript(v);
            onSetScript(v);
            onFlushSave?.(v);
          }}
        />
        <div
          role="separator"
          aria-orientation="horizontal"
          className={`mt-1.5 h-2 shrink-0 rounded border border-white/15 bg-black/35 ${locked ? "cursor-not-allowed opacity-40" : "cursor-ns-resize hover:bg-white/10"}`}
          onPointerDown={onEditorResizePointerDown}
          title={locked ? "Unlock to resize editor" : "Drag down to enlarge editor panel"}
        />

        <div className="mt-2 flex shrink-0 flex-col gap-2 border-t border-white/15 pt-2">
          <div className="grid grid-cols-2 gap-x-2 gap-y-2 text-[10px]">
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-white/90">Speed: {Math.round(speed)} px/s</span>
              <input
                type="range"
                min={10}
                max={80}
                step={2}
                value={speed}
                className="w-full"
                onChange={(e) => onSetSpeed(Number(e.target.value))}
              />
              <span className="text-[10px] leading-tight text-white/55">
                Ref: 30–40 news | 40–50 interview | 50–60 casual
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-white/90">Font: {Math.round(fontSize)} px</span>
              <input
                type="range"
                min={18}
                max={52}
                step={1}
                value={fontSize}
                className="w-full"
                onChange={(e) => onSetFontSize(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-white/90">Opacity: {opacity.toFixed(2)}</span>
              <input
                type="range"
                min={0.35}
                max={1}
                step={0.01}
                value={opacity}
                className="w-full"
                onChange={(e) => onSetOpacity(Number(e.target.value))}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-white/90">Width: {Math.round(overlayWidth)} px</span>
              <input
                type="range"
                min={320}
                max={900}
                step={10}
                value={overlayWidth}
                className="w-full"
                onChange={(e) => onSetOverlayWidth(Number(e.target.value))}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[10px] text-white/90">
            <input type="checkbox" checked={nearCamera} onChange={(e) => onSetNearCamera(e.target.checked)} />
            <span>Near camera</span>
          </label>
          <p className="text-[10px] leading-snug text-white/60">
            Shortcuts: Space play/pause, Up/Down speed, R reset, H hide. Drag overlay to scroll. Scroll editor to sync overlay. Drag corner to resize panel.
          </p>
        </div>
      </div>
      <div
        role="button"
        tabIndex={0}
        onPointerDown={onPanelResizePointerDown}
        className={`absolute bottom-0 right-0 z-30 h-[14px] w-[14px] cursor-se-resize rounded-br-xl ${locked ? "pointer-events-none opacity-35" : "hover:bg-white/[0.06]"}`}
        style={{
          background:
            "linear-gradient(to top left, rgba(255,255,255,.22) 0%, rgba(255,255,255,.22) 42%, transparent 42.5%)",
        }}
        title={locked ? "Unlock to resize" : "Drag to resize panel"}
        aria-label="Resize panel"
      />
    </div>
  );

  return typeof document !== "undefined" ? createPortal(panelEl, document.body) : null;
}
