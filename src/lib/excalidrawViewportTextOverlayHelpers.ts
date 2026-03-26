function textareaLooksUsable(el: HTMLTextAreaElement): boolean {
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden") return false;
  const op = Number.parseFloat(st.opacity);
  if (Number.isFinite(op) && op === 0) return false;
  if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
  return true;
}

function intersectionArea(a: DOMRectReadOnly, b: DOMRectReadOnly): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const w = right - left;
  const h = bottom - top;
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Excalidraw’s text field can sit outside a narrow ancestor subtree; scope to the whiteboard
 * panel by **intersection** with its screen rect (still only real `<textarea>` nodes).
 */
function bestTextareaIntersectingPanel(
  panelR: DOMRectReadOnly,
  requireExcalidrawAncestor: boolean
): HTMLTextAreaElement | null {
  let best: HTMLTextAreaElement | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll("textarea")) {
    if (!(el instanceof HTMLTextAreaElement)) continue;
    if (requireExcalidrawAncestor && !el.closest(".excalidraw, .excalidraw-wrapper")) continue;
    if (!textareaLooksUsable(el)) continue;
    const tr = el.getBoundingClientRect();
    const area = intersectionArea(panelR, tr);
    if (area <= 0) continue;
    if (area >= bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

export function findVisibleExcalidrawTextarea(whiteboardPanel: HTMLElement): HTMLTextAreaElement | null {
  const panelR = whiteboardPanel.getBoundingClientRect();
  if (panelR.width < 2 || panelR.height < 2) return null;

  const strict = bestTextareaIntersectingPanel(panelR, true);
  if (strict) return strict;
  return bestTextareaIntersectingPanel(panelR, false);
}

export function textareaDestRectCss(
  container: HTMLElement,
  ta: HTMLTextAreaElement
): { left: number; top: number; width: number; height: number } {
  const cr = container.getBoundingClientRect();
  const tr = ta.getBoundingClientRect();
  return {
    left: tr.left - cr.left,
    top: tr.top - cr.top,
    width: tr.width,
    height: tr.height,
  };
}

export function cssRectToCanvasPixels(
  r: { left: number; top: number; width: number; height: number },
  cssW: number,
  cssH: number,
  pw: number,
  ph: number
): { dx: number; dy: number; dw: number; dh: number } {
  const w = Math.max(1, cssW);
  const h = Math.max(1, cssH);
  return {
    dx: (r.left / w) * pw,
    dy: (r.top / h) * ph,
    dw: (r.width / w) * pw,
    dh: (r.height / h) * ph,
  };
}

/** Standalone text only (legacy helper / tests). */
export function isStandaloneTextBeingEdited(appState: Record<string, unknown>): boolean {
  const ed = appState.editingTextElement;
  if (!ed || typeof ed !== "object") return false;
  const o = ed as Record<string, unknown>;
  if (o.type !== "text") return false;
  return o.containerId == null;
}

/** Any in-canvas text edit: standalone or bound to a shape (containerId set). */
export function isExcalidrawTextEditActive(appState: Record<string, unknown>): boolean {
  const ed = appState.editingTextElement;
  if (ed && typeof ed === "object" && (ed as Record<string, unknown>).type === "text") return true;
  const ne = appState.newElement;
  if (ne && typeof ne === "object" && (ne as Record<string, unknown>).type === "text") return true;
  return false;
}

/** Element to render for export: prefer committed editor, else in-progress new text. */
export function pickEditingTextElement(appState: Record<string, unknown>): Record<string, unknown> | null {
  const ed = appState.editingTextElement;
  if (ed && typeof ed === "object" && (ed as Record<string, unknown>).type === "text") {
    return ed as Record<string, unknown>;
  }
  const ne = appState.newElement;
  if (ne && typeof ne === "object" && (ne as Record<string, unknown>).type === "text") {
    return ne as Record<string, unknown>;
  }
  return null;
}
