import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import {
  computeWhiteboardRecordingSurfacePx,
  wbEncodeUniformLetterbox,
  wbRecordPipOutputRect,
  wbRecordPipCssPosFromOutputCenter,
} from "@/lib/wbRecordingLayoutPreview";
import { effectiveShareFillPercent } from "@/lib/recordLayout";

const Z_PANEL = "z-[1000040]";
/** Mini preview: long side (px) — landscape → width; portrait → height. */
const MINI_PREVIEW_LONG_SIDE = 118;
const VIEWPORT_MARGIN = 8;
const PANEL_PADDING_X = 12;
const PANEL_PADDING_Y = 10;

type LayoutDragState =
  | {
      kind: "pip";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startCxOut: number;
      startCyOut: number;
      /** Frozen at pointerdown — per-frame `getBoundingClientRect` jitter changes letterbox `s` and inverts to unstable CSS → clamp hits 0. */
      mapW: number;
      mapH: number;
    }
  | {
      kind: "wbPan";
      pointerId: number;
      startPan: { x: number; y: number };
      startClientX: number;
      startClientY: number;
    }
  | {
      kind: "resizeShare";
      pointerId: number;
      startPct: number;
      startClientY: number;
    };

type PanelPos = { left: number; bottom: number };

export type WbRecordLayoutMinimapPanelProps = {
  outW: number;
  outH: number;
  pipMapW: number;
  pipMapH: number;
  pipX: number;
  pipY: number;
  pipWCss: number;
  pipHCss: number;
  iw: number;
  ih: number;
  sharePercent: number;
  surfacePanNorm: { x: number; y: number };
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  /** Called on pointer-up with final CSS PiP position (commit to React state). */
  onPipChange: (p: { x: number; y: number }) => void;
  /**
   * Optional: high-frequency PiP moves while dragging minimap orange box.
   * Use with onPipChange on pointer-up — avoids flushSync / setState per pointermove (main lag source).
   */
  onPipLive?: (p: { x: number; y: number }) => void;
  /** True while the amber PiP handle is actively dragged — lets the host refresh overlay/composite every frame. */
  onPipMiniDragActive?: (active: boolean) => void;
  onSurfacePanChange: (p: { x: number; y: number }) => void;
  /** Commit Share % after minimap resize pointer-up */
  onSharePercentChange: (pct: number) => void;
  /** Optional live updates while resizing — pair with onSharePercentChange on up (smooth: ref + composite, no per-move React state). */
  onSharePercentLive?: (pct: number) => void;
  /** Bumped by host during live minimap PiP drag so parent re-renders with latest `pipX`/`pipY` from ref. */
  layoutSyncTick?: number;
  /** Live preview canvas CSS size — must match `drawComposite`; avoids stale `pipMapW/H` props clamping commits to (0,0). */
  getPipMapCssSize?: () => { w: number; h: number } | null;
};

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

/** Align with `drawComposite` / App `previewStable` — tiny maps blow up letterbox math → orange PiP glued to top-left. */
const MIN_PIP_MAP_CSS = 50;

const MIN_MINI_MAP_PIP_PX = 6;

/** Minimap amber PiP: intersect with stage, never collapse below MIN (avoids «disappearing» PiP thin border). */
function clampPipMiniStage(
  pr: { x: number; y: number; pw: number; ph: number },
  sc: number,
  maxW: number,
  maxH: number
): { left: number; top: number; width: number; height: number } {
  const rawW = Math.max(0, pr.pw * sc);
  const rawH = Math.max(0, pr.ph * sc);
  const rawLeft = pr.x * sc;
  const rawTop = pr.y * sc;

  const ix1 = clamp(rawLeft, 0, maxW);
  const iy1 = clamp(rawTop, 0, maxH);
  const ix2 = clamp(rawLeft + rawW, 0, maxW);
  const iy2 = clamp(rawTop + rawH, 0, maxH);

  let left = ix1;
  let top = iy1;
  let width = ix2 - ix1;
  let height = iy2 - iy1;

  if (
    width < MIN_MINI_MAP_PIP_PX ||
    height < MIN_MINI_MAP_PIP_PX ||
    ix2 <= ix1 ||
    iy2 <= iy1
  ) {
    const wf = clamp(Math.max(rawW, MIN_MINI_MAP_PIP_PX), MIN_MINI_MAP_PIP_PX, maxW);
    const hf = clamp(Math.max(rawH, MIN_MINI_MAP_PIP_PX), MIN_MINI_MAP_PIP_PX, maxH);
    const cxRaw = rawLeft + rawW / 2;
    const cyRaw = rawTop + rawH / 2;
    const cx = clamp(cxRaw, wf / 2, maxW - wf / 2);
    const cy = clamp(cyRaw, hf / 2, maxH - hf / 2);
    left = cx - wf / 2;
    top = cy - hf / 2;
    width = wf;
    height = hf;
  }

  return { left, top, width, height };
}

function clampPanelToViewport(panelEl: HTMLElement | null, pos: PanelPos): PanelPos {
  if (!panelEl || typeof window === "undefined") return pos;
  const { width: w, height: h } = panelEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxL = Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN);
  const maxB = Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN);
  return {
    left: clamp(pos.left, VIEWPORT_MARGIN, maxL),
    bottom: clamp(pos.bottom, VIEWPORT_MARGIN, maxB),
  };
}

/** Whiteboard-only recording: compact layout preview; drag panel chrome to move; green = pan, green SE = Share %. */
export function WbRecordLayoutMinimapPanel({
  outW,
  outH,
  pipMapW,
  pipMapH,
  pipX,
  pipY,
  pipWCss,
  pipHCss,
  iw,
  ih,
  sharePercent,
  surfacePanNorm,
  expanded,
  onExpandedChange,
  onPipChange,
  onPipLive,
  onSurfacePanChange,
  onSharePercentChange,
  onSharePercentLive,
  layoutSyncTick,
  onPipMiniDragActive,
  getPipMapCssSize,
}: WbRecordLayoutMinimapPanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<PanelPos>(() => ({
    left: VIEWPORT_MARGIN,
    bottom: VIEWPORT_MARGIN,
  }));
  const pipMiniDragLastRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * While dragging the amber PiP on *this* minimap: host `layoutSyncTick`/flushSync can re-render with
   * transient `pipX`/`pipY` (even 0) — React-applied `style.left/top` then overwrites imperative moves → snap to corner.
   * This flag + `pipMiniDragLastRef` are the display source of truth until pointer-up.
   */
  const [minimapPipDragActive, setMinimapPipDragActive] = useState(false);
  const [pipMapDisplay, setPipMapDisplay] = useState(() => ({
    w: Math.max(MIN_PIP_MAP_CSS, pipMapW),
    h: Math.max(MIN_PIP_MAP_CSS, pipMapH),
  }));
  const pipMiniOverlayRef = useRef<HTMLDivElement | null>(null);
  const wbMiniGreenOverlayRef = useRef<HTMLDivElement | null>(null);
  const wbMiniSharePctLabelRef = useRef<HTMLSpanElement | null>(null);
  /** Last Share % during SE drag; committed on pointer-up. */
  const shareResizeLastRef = useRef<number | null>(null);
  const layoutDragRef = useRef<LayoutDragState | null>(null);
  const panelDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startLeft: number;
    startBottom: number;
  } | null>(null);
  const panelPosRef = useRef(panelPos);
  if (!panelDragRef.current) {
    panelPosRef.current = panelPos;
  }

  useLayoutEffect(() => {
    setPipMapDisplay((prev) => {
      const live = getPipMapCssSize?.();
      let w = pipMapW >= MIN_PIP_MAP_CSS ? pipMapW : prev.w;
      let h = pipMapH >= MIN_PIP_MAP_CSS ? pipMapH : prev.h;
      if (live && live.w >= MIN_PIP_MAP_CSS && live.h >= MIN_PIP_MAP_CSS) {
        w = live.w;
        h = live.h;
      }
      w = Math.max(MIN_PIP_MAP_CSS, w);
      h = Math.max(MIN_PIP_MAP_CSS, h);
      if (w === prev.w && h === prev.h) return prev;
      return { w, h };
    });
  }, [pipMapW, pipMapH, getPipMapCssSize, layoutSyncTick]);

  const fillRatio = effectiveShareFillPercent(sharePercent) / 100;
  const wb = computeWhiteboardRecordingSurfacePx(
    outW,
    outH,
    Math.max(1, iw),
    Math.max(1, ih),
    fillRatio,
    surfacePanNorm
  );
  const dragLast = pipMiniDragLastRef.current;
  const displayPipX =
    minimapPipDragActive && dragLast ? dragLast.x : pipX;
  const displayPipY =
    minimapPipDragActive && dragLast ? dragLast.y : pipY;
  const pip = wbRecordPipOutputRect({
    outW,
    outH,
    pipMapW: pipMapDisplay.w,
    pipMapH: pipMapDisplay.h,
    pipX: displayPipX,
    pipY: displayPipY,
    pipWCss,
    pipHCss,
  });

  const ow = Math.max(1, outW);
  const oh = Math.max(1, outH);
  const landscape = ow >= oh;
  /** Stage fills output aspect ratio; long side follows recording orientation (landscape = wide bar, portrait = tall bar). */
  let stagePxW: number;
  let stagePxH: number;
  let scale: number;
  if (landscape) {
    stagePxW = MINI_PREVIEW_LONG_SIDE;
    stagePxH = Math.max(1, Math.round(MINI_PREVIEW_LONG_SIDE * (oh / ow)));
    scale = stagePxW / ow;
  } else {
    stagePxH = MINI_PREVIEW_LONG_SIDE;
    stagePxW = Math.max(1, Math.round(MINI_PREVIEW_LONG_SIDE * (ow / oh)));
    scale = stagePxH / oh;
  }

  const pipMini = clampPipMiniStage(pip, scale, stagePxW, stagePxH);
  const applyPipMiniOverlay = useCallback(
    (box: { left: number; top: number; width: number; height: number }) => {
      const el = pipMiniOverlayRef.current;
      if (!el) return;
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    },
    []
  );

  const expandedCardWidth = stagePxW + 2 * PANEL_PADDING_X;

  const clampSelf = useCallback(() => {
    setPanelPos((p) => clampPanelToViewport(rootRef.current, p));
  }, []);

  useLayoutEffect(() => {
    clampSelf();
  }, [expanded, clampSelf]);

  useLayoutEffect(() => {
    if (minimapPipDragActive) return;
    applyPipMiniOverlay(pipMini);
  }, [applyPipMiniOverlay, minimapPipDragActive, pipMini.left, pipMini.top, pipMini.width, pipMini.height]);

  useEffect(() => {
    const onResize = () => clampSelf();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampSelf]);

  const onPanelPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panelDragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startLeft: panelPosRef.current.left,
      startBottom: panelPosRef.current.bottom,
    };
  }, []);

  const onPanelPointerMove = useCallback((e: React.PointerEvent) => {
    const d = panelDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    const left = d.startLeft + dx;
    const bottom = d.startBottom - dy;
    panelPosRef.current = { left, bottom };
    const root = rootRef.current;
    if (root) {
      root.style.left = `${left}px`;
      root.style.bottom = `${bottom}px`;
    }
  }, []);

  const onPanelPointerUp = useCallback((e: React.PointerEvent) => {
    const d = panelDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    panelDragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const root = rootRef.current;
    const next = clampPanelToViewport(root, panelPosRef.current);
    if (root) {
      root.style.removeProperty("left");
      root.style.removeProperty("bottom");
    }
    panelPosRef.current = next;
    setPanelPos(next);
  }, []);

  const startLayoutDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !stageRef.current) return;
      const r = stageRef.current.getBoundingClientRect();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      const ox = lx / scale;
      const oy = ly / scale;

      const hHandle = 11 / scale;
      const inResizeShare =
        ox >= wb.x + wb.w - hHandle &&
        oy >= wb.y + wb.h - hHandle &&
        ox <= wb.x + wb.w &&
        oy <= wb.y + wb.h;

      const inWb =
        ox >= wb.x && ox <= wb.x + wb.w && oy >= wb.y && oy <= wb.y + wb.h && !inResizeShare;
      if (inResizeShare) {
        shareResizeLastRef.current = sharePercent;
        layoutDragRef.current = {
          kind: "resizeShare",
          pointerId: e.pointerId,
          startPct: sharePercent,
          startClientY: e.clientY,
        };
      } else if (inWb) {
        layoutDragRef.current = {
          kind: "wbPan",
          pointerId: e.pointerId,
          startPan: { ...surfacePanNorm },
          startClientX: e.clientX,
          startClientY: e.clientY,
        };
      } else {
        return;
      }
      stageRef.current.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [
      wb,
      scale,
      sharePercent,
      surfacePanNorm,
    ]
  );

  const moveLayoutDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = layoutDragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      if (d.kind === "pip") {
        const { mapW, mapH } = d;
        if (mapW < pipWCss || mapH < pipHCss) return;
        const dxOut = (e.clientX - d.startClientX) / scale;
        const dyOut = (e.clientY - d.startClientY) / scale;
        const { s } = wbEncodeUniformLetterbox(outW, outH, mapW, mapH);
        const pwOut = pipWCss * s;
        const phOut = pipHCss * s;
        let cxOut = d.startCxOut + dxOut;
        let cyOut = d.startCyOut + dyOut;
        cxOut = clamp(cxOut, pwOut / 2, outW - pwOut / 2);
        cyOut = clamp(cyOut, phOut / 2, outH - phOut / 2);
        const raw = wbRecordPipCssPosFromOutputCenter({
          outW,
          outH,
          pipMapW: mapW,
          pipMapH: mapH,
          pipWCss,
          pipHCss,
          cxOut,
          cyOut,
        });
        const pCss = {
          x: clamp(raw.x, 0, Math.max(0, mapW - pipWCss)),
          y: clamp(raw.y, 0, Math.max(0, mapH - pipHCss)),
        };
        pipMiniDragLastRef.current = pCss;
        if (onPipLive) {
          onPipLive(pCss);
        } else {
          onPipChange(pCss);
        }
        const pr = wbRecordPipOutputRect({
          outW,
          outH,
          pipMapW: mapW,
          pipMapH: mapH,
          pipX: pCss.x,
          pipY: pCss.y,
          pipWCss,
          pipHCss,
        });
        applyPipMiniOverlay(clampPipMiniStage(pr, scale, stagePxW, stagePxH));
      } else if (d.kind === "wbPan") {
        const dxOut = (e.clientX - d.startClientX) / scale;
        const dyOut = (e.clientY - d.startClientY) / scale;
        const slackX = outW - wb.w;
        const slackY = outH - wb.h;
        let nx = d.startPan.x;
        let ny = d.startPan.y;
        if (slackX > 0.5) {
          nx = clamp(d.startPan.x + (2 * dxOut) / slackX, -1, 1);
        }
        if (slackY > 0.5) {
          ny = clamp(d.startPan.y + (2 * dyOut) / slackY, -1, 1);
        }
        onSurfacePanChange({ x: nx, y: ny });
      } else if (d.kind === "resizeShare") {
        const dy = e.clientY - d.startClientY;
        const sens = 0.22;
        const pct = clamp(Math.round(d.startPct + dy * sens), 40, 100);
        shareResizeLastRef.current = pct;
        if (onSharePercentLive) {
          onSharePercentLive(pct);
        } else {
          onSharePercentChange(pct);
        }
        const fill = effectiveShareFillPercent(pct) / 100;
        const wbLive = computeWhiteboardRecordingSurfacePx(
          outW,
          outH,
          Math.max(1, iw),
          Math.max(1, ih),
          fill,
          surfacePanNorm
        );
        const gel = wbMiniGreenOverlayRef.current;
        if (gel) {
          gel.style.left = `${wbLive.x * scale}px`;
          gel.style.top = `${wbLive.y * scale}px`;
          gel.style.width = `${wbLive.w * scale}px`;
          gel.style.height = `${wbLive.h * scale}px`;
        }
        const lab = wbMiniSharePctLabelRef.current;
        if (lab) {
          lab.textContent = `${pct}%`;
        }
      }
    },
    [
      iw,
      ih,
      onPipChange,
      onPipLive,
      onSurfacePanChange,
      onSharePercentChange,
      onSharePercentLive,
      outH,
      outW,
      pipHCss,
      pipMapH,
      pipMapW,
      pipWCss,
      scale,
      stagePxH,
      stagePxW,
      surfacePanNorm,
      wb.h,
      wb.w,
      applyPipMiniOverlay,
    ]
  );

  const endLayoutDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = layoutDragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const kind = d.kind;
      /** Same map dims as start — avoids 1px rect jitter flipping clamp to (0,0) on release. */
      const pipMapForCommit =
        d.kind === "pip" ? { mapW: d.mapW, mapH: d.mapH } : null;
      layoutDragRef.current = null;
      try {
        stageRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (kind === "pip" && pipMapForCommit) {
        setMinimapPipDragActive(false);
        const { mapW, mapH } = pipMapForCommit;
        const rawLast = pipMiniDragLastRef.current;
        pipMiniDragLastRef.current = null;
        if (rawLast) {
          onPipChange({
            x: clamp(rawLast.x, 0, Math.max(0, mapW - pipWCss)),
            y: clamp(rawLast.y, 0, Math.max(0, mapH - pipHCss)),
          });
        }
        onPipMiniDragActive?.(false);
      } else if (kind === "resizeShare") {
        const gel = wbMiniGreenOverlayRef.current;
        if (gel) {
          gel.style.removeProperty("left");
          gel.style.removeProperty("top");
          gel.style.removeProperty("width");
          gel.style.removeProperty("height");
        }
        const v = shareResizeLastRef.current;
        shareResizeLastRef.current = null;
        if (typeof v === "number" && onSharePercentLive) {
          onSharePercentChange(v);
        }
      }
    },
    [onPipChange, onSharePercentChange, onSharePercentLive, onPipMiniDragActive, pipWCss, pipHCss]
  );

  const expandedHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button[type='button']")) return;
      onPanelPointerDown(e);
    },
    [onPanelPointerDown]
  );

  return (
    <div
      ref={rootRef}
      data-dreamwork-no-intercept
      className={`fixed ${Z_PANEL}`}
      style={{ left: panelPos.left, bottom: panelPos.bottom }}
    >
      {!expanded ? (
        <div className="flex items-stretch overflow-hidden rounded-lg border border-slate-300/90 bg-white/95 shadow-lg backdrop-blur-sm">
          <div
            className="flex w-7 shrink-0 cursor-grab touch-none flex-col items-center justify-center gap-px border-r border-slate-200 bg-slate-50/90 active:cursor-grabbing"
            aria-label="Drag panel"
            title="Drag to move"
            onPointerDown={onPanelPointerDown}
            onPointerMove={onPanelPointerMove}
            onPointerUp={onPanelPointerUp}
            onPointerCancel={onPanelPointerUp}
          >
            <GripVertical className="size-3.5 shrink-0 text-slate-400" aria-hidden />
          </div>
          <button
            type="button"
            className="px-2.5 py-1.5 text-left text-[11px] font-semibold text-slate-800 hover:bg-white/70"
            onClick={() => onExpandedChange(true)}
          >
            Recording layout
          </button>
        </div>
      ) : (
        <div
          className="rounded-lg border border-slate-200/90 bg-white/95 shadow-xl backdrop-blur-sm"
          style={{
            width: expandedCardWidth,
            paddingLeft: PANEL_PADDING_X,
            paddingRight: PANEL_PADDING_X,
            paddingTop: PANEL_PADDING_Y,
            paddingBottom: PANEL_PADDING_Y,
          }}
        >
          <div
            className="mb-2 flex cursor-grab touch-none items-center justify-between gap-2 active:cursor-grabbing"
            onPointerDown={expandedHeaderPointerDown}
            onPointerMove={onPanelPointerMove}
            onPointerUp={onPanelPointerUp}
            onPointerCancel={onPanelPointerUp}
          >
            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              Recording layout
            </span>
            <button
              type="button"
              aria-label="Collapse"
              className="cursor-pointer shrink-0 rounded px-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              onClick={(ev) => {
                ev.stopPropagation();
                onExpandedChange(false);
              }}
            >
              −
            </button>
          </div>
          <div className="mx-auto flex w-full flex-col items-stretch" style={{ width: stagePxW }}>
            <p className="mb-1.5 w-full break-words text-[6.5px] leading-[1.15] tracking-tight text-slate-500">
              Green = board · Orange = PiP preview only · Drag green to pan · SE: Share%
            </p>
            <div
              ref={stageRef}
              className="relative cursor-default select-none overflow-hidden rounded bg-slate-900 ring-1 ring-slate-600/40"
              style={{ width: stagePxW, height: stagePxH }}
              onPointerDown={startLayoutDrag}
              onPointerMove={moveLayoutDrag}
              onPointerUp={endLayoutDrag}
              onPointerCancel={endLayoutDrag}
            >
              <div
                className="pointer-events-none absolute inset-0 bg-gradient-to-br from-slate-800 via-slate-900 to-black opacity-90"
                aria-hidden
              />
              <div
                ref={wbMiniGreenOverlayRef}
                className="pointer-events-none absolute border-2 border-emerald-400/90 bg-emerald-500/15"
                style={{
                  left: wb.x * scale,
                  top: wb.y * scale,
                  width: wb.w * scale,
                  height: wb.h * scale,
                }}
              />
              <div
                ref={pipMiniOverlayRef}
                className="pointer-events-none absolute border-2 border-amber-400 bg-amber-500/25"
              />
            </div>
            <div className="mt-2 flex w-full justify-between gap-2 text-[9px] tabular-nums text-slate-500">
              <span>{outW}×{outH}</span>
              <span ref={wbMiniSharePctLabelRef}>{sharePercent}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
