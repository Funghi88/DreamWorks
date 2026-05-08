import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  clampSettingsPanelGeom,
  type SettingsPanelGeom,
} from "@/lib/settingsPanelGeom";

const MIN_W = 300;
const MIN_H = 260;

export type { SettingsPanelGeom };

type Props = {
  open: boolean;
  onClose: () => void;
  geom: SettingsPanelGeom;
  onGeomChange: (g: SettingsPanelGeom) => void;
  title: string;
  titleId: string;
  /** Tailwind z-index class, e.g. z-[1000025] */
  zClassName: string;
  children: ReactNode;
};

/**
 * Floating, draggable header + SE resize. No fullscreen backdrop — user can see capture / PiP behind.
 */
export function SettingsFloatingPanel({
  open,
  onClose,
  geom,
  onGeomChange,
  title,
  titleId,
  zClassName,
  children,
}: Props) {
  const geomRef = useRef(geom);
  geomRef.current = geom;

  const dragRef = useRef<{ pointerId: number; sx: number; sy: number; ox: number; oy: number } | null>(
    null
  );
  const resizeRef = useRef<{
    pointerId: number;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
  } | null>(null);

  const endDragResize = useCallback(() => {
    dragRef.current = null;
    resizeRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      endDragResize();
      return;
    }

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (d && e.pointerId === d.pointerId) {
        const nx = d.ox + (e.clientX - d.sx);
        const ny = d.oy + (e.clientY - d.sy);
        onGeomChange(clampSettingsPanelGeom({ ...geomRef.current, x: nx, y: ny }));
        return;
      }
      const r = resizeRef.current;
      if (r && e.pointerId === r.pointerId) {
        const dw = e.clientX - r.sx;
        const dh = e.clientY - r.sy;
        const nw = Math.max(MIN_W, Math.round(r.ow + dw));
        const nh = Math.max(MIN_H, Math.round(r.oh + dh));
        onGeomChange(
          clampSettingsPanelGeom({
            x: r.ox,
            y: r.oy,
            w: nw,
            h: nh,
          })
        );
      }
    };

    const onUp = (e: PointerEvent) => {
      if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
      if (resizeRef.current?.pointerId === e.pointerId) resizeRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [open, onGeomChange, endDragResize]);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = geomRef.current;
    dragRef.current = {
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: g.x,
      oy: g.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const g = geomRef.current;
    resizeRef.current = {
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: g.x,
      oy: g.y,
      ow: g.w,
      oh: g.h,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  if (!open) return null;

  return (
    <div
      data-dreamwork-no-intercept
      role="dialog"
      aria-modal={false}
      aria-labelledby={titleId}
      className={`fixed ${zClassName} flex flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-white text-slate-900 shadow-xl ring-1 ring-black/5`}
      style={{
        left: geom.x,
        top: geom.y,
        width: geom.w,
        height: geom.h,
      }}
    >
      <div
        className="flex shrink-0 cursor-grab select-none items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/95 px-3 py-3 touch-none active:cursor-grabbing"
        onPointerDown={onHeaderPointerDown}
      >
        <span id={titleId} className="truncate text-lg font-semibold tracking-tight text-slate-900">
          {title}
        </span>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onClose()}
          className="shrink-0 rounded p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          aria-label="Close settings"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-5">{children}</div>
      <div
        role="presentation"
        title="Resize"
        className="pointer-events-auto absolute bottom-0 right-0 z-10 cursor-nwse-resize touch-none"
        style={{ width: 18, height: 18 }}
        onPointerDown={onResizePointerDown}
        aria-hidden
      />
    </div>
  );
}
