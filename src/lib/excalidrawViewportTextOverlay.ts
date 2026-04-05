import {
  exportToCanvas,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import {
  cssRectToCanvasPixels,
  findVisibleExcalidrawTextarea,
  isExcalidrawTextEditActive,
  pickEditingTextElement,
  textareaDestRectCss,
} from "./excalidrawViewportTextOverlayHelpers";

export {
  cssRectToCanvasPixels,
  findVisibleExcalidrawTextarea,
  isExcalidrawTextEditActive,
  isStandaloneTextBeingEdited,
  pickEditingTextElement,
  textareaDestRectCss,
} from "./excalidrawViewportTextOverlayHelpers";

/** Narrow API surface for whiteboard recording. */
export type MinimalExcalidrawRecordingApi = {
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  getSceneElements: () => readonly unknown[];
};

function viewportStateFromAppState(appState: Record<string, unknown>): {
  zoom: { value: number };
  offsetLeft: number;
  offsetTop: number;
  scrollX: number;
  scrollY: number;
} {
  const zoomRaw = appState.zoom as { value?: number } | undefined;
  const z = typeof zoomRaw?.value === "number" ? zoomRaw.value : 1;
  return {
    zoom: { value: z },
    offsetLeft: Number(appState.offsetLeft ?? 0),
    offsetTop: Number(appState.offsetTop ?? 0),
    scrollX: Number(appState.scrollX ?? 0),
    scrollY: Number(appState.scrollY ?? 0),
  };
}

type ViewportToSceneArg = Parameters<typeof viewportCoordsToSceneCoords>[1];

/**
 * Live <textarea> grows with typed text; Excalidraw's editingTextElement width/height often lag (≈1 glyph),
 * so exportToCanvas clips to a tiny box and recordings show only the first character.
 */
function textareaClientRectToSceneBounds(
  ta: HTMLTextAreaElement,
  appState: Record<string, unknown>
): { x: number; y: number; width: number; height: number } | null {
  const tr = ta.getBoundingClientRect();
  if (tr.width < 2 || tr.height < 2) return null;
  const st = viewportStateFromAppState(appState) as ViewportToSceneArg;
  const tl = viewportCoordsToSceneCoords({ clientX: tr.left, clientY: tr.top }, st);
  const br = viewportCoordsToSceneCoords({ clientX: tr.right, clientY: tr.bottom }, st);
  const x = Math.min(tl.x, br.x);
  const y = Math.min(tl.y, br.y);
  const width = Math.abs(br.x - tl.x);
  const height = Math.abs(br.y - tl.y);
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

/** Fallback placement when no textarea is found (API-only path). Skips rotation. */
export function approxTextBoxViewportCss(
  el: Record<string, unknown>,
  appState: Record<string, unknown>
): { left: number; top: number; width: number; height: number } {
  const st = viewportStateFromAppState(appState);
  const x = Number(el.x ?? 0);
  const y = Number(el.y ?? 0);
  const w = Number(el.width ?? 0);
  const h = Number(el.height ?? 0);
  const tl = sceneCoordsToViewportCoords(
    { sceneX: x, sceneY: y },
    st as Parameters<typeof sceneCoordsToViewportCoords>[1]
  );
  return {
    left: tl.x,
    top: tl.y,
    width: w * st.zoom.value,
    height: h * st.zoom.value,
  };
}

function buildExportElements(
  api: MinimalExcalidrawRecordingApi,
  patchedText: Record<string, unknown>
): unknown[] {
  const cid = patchedText.containerId;
  if (cid == null || cid === "") return [patchedText];
  const all = api.getSceneElements() as Record<string, unknown>[];
  const cont = all.find((e) => e && typeof e === "object" && e.id === cid);
  if (!cont) return [patchedText];
  const ti = all.findIndex((e) => e && e.id === patchedText.id);
  const ci = all.findIndex((e) => e && e.id === cid);
  if (ti >= 0 && ci >= 0 && ci < ti) return [cont, patchedText];
  if (ti >= 0 && ci >= 0 && ci > ti) return [patchedText, cont];
  return [cont, patchedText];
}

/**
 * Map export bitmap into the textarea / element box without non-uniform scale.
 * Stretching a tight text glyph canvas to a wide <textarea> caused horizontal “smear” in recordings.
 */
function drawTextExportContainTopLeft(
  ctx: CanvasRenderingContext2D,
  textCanvas: HTMLCanvasElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  const tw = textCanvas.width;
  const th = textCanvas.height;
  if (tw < 1 || th < 1 || dw < 2 || dh < 2) return;
  const scale = Math.min(dw / tw, dh / th);
  const outW = tw * scale;
  const outH = th * scale;
  ctx.drawImage(textCanvas, 0, 0, tw, th, dx, dy, outW, outH);
}

async function exportTextPatchCanvas(
  api: MinimalExcalidrawRecordingApi,
  appState: Record<string, unknown>,
  patchedText: Record<string, unknown>
): Promise<HTMLCanvasElement | null> {
  const elements = buildExportElements(api, patchedText);
  try {
    return await exportToCanvas({
      elements: elements as Parameters<typeof exportToCanvas>[0]["elements"],
      appState: { ...(appState as object), exportWithDarkMode: false } as Parameters<
        typeof exportToCanvas
      >[0]["appState"],
      files: api.getFiles() as Parameters<typeof exportToCanvas>[0]["files"],
      exportPadding: 0,
      maxWidthOrHeight: 4096,
    });
  } catch {
    try {
      return await exportToCanvas({
        elements: [patchedText] as Parameters<typeof exportToCanvas>[0]["elements"],
        appState: { ...(appState as object), exportWithDarkMode: false } as Parameters<
          typeof exportToCanvas
        >[0]["appState"],
        files: api.getFiles() as Parameters<typeof exportToCanvas>[0]["files"],
        exportPadding: 0,
        maxWidthOrHeight: 4096,
      });
    } catch {
      return null;
    }
  }
}

/**
 * Synchronous per-frame text overlay: reads the live Excalidraw <textarea> and paints its
 * content with ctx.fillText. Much cheaper than exportToCanvas — designed to run every frame.
 */
export function drawEditingTextOverlaySync(
  ctx: CanvasRenderingContext2D,
  container: HTMLElement,
  cssW: number,
  cssH: number,
  pw: number,
  ph: number,
): void {
  const ta = findVisibleExcalidrawTextarea(container);
  if (!ta) return;
  const text = ta.value;
  if (!text) return;

  const cs = getComputedStyle(ta);
  const cssRect = textareaDestRectCss(container, ta);
  const { dx, dy, dw, dh } = cssRectToCanvasPixels(cssRect, cssW, cssH, pw, ph);
  if (dw < 2 || dh < 2) return;

  const scaleX = pw / Math.max(1, cssW);
  const scaleY = ph / Math.max(1, cssH);
  const fontSizePx = parseFloat(cs.fontSize) || 16;
  const scaledFontSize = fontSizePx * scaleY;
  const lineHeight = parseFloat(cs.lineHeight) || fontSizePx * 1.35;
  const scaledLineHeight = lineHeight * scaleY;
  const color = cs.color || "#000";
  const fontFamily = cs.fontFamily || "sans-serif";
  const fontWeight = cs.fontWeight || "normal";
  const fontStyle = cs.fontStyle || "normal";
  const textAlign = (cs.textAlign || "left") as CanvasTextAlign;

  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();

  ctx.font = `${fontStyle} ${fontWeight} ${scaledFontSize}px ${fontFamily}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.textAlign = textAlign;

  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const textX = textAlign === "center" ? dx + dw / 2
    : textAlign === "right" ? dx + dw - padLeft * scaleX
    : dx + padLeft * scaleX;
  let textY = dy + padTop * scaleY;

  const lines = text.split("\n");
  for (const line of lines) {
    if (textY > dy + dh) break;
    ctx.fillText(line, textX, textY, dw);
    textY += scaledLineHeight;
  }

  ctx.restore();
}

/**
 * After viewport canvas stack (or full export), paint in-progress text via exportToCanvas,
 * positioned with the live textarea rect when possible. Covers standalone and container-bound text.
 */
export async function drawStandaloneEditingTextOverlay(
  out: HTMLCanvasElement,
  container: HTMLElement,
  cssW: number,
  cssH: number,
  api: MinimalExcalidrawRecordingApi
): Promise<void> {
  const appState = api.getAppState();
  if (!isExcalidrawTextEditActive(appState)) return;

  const base = pickEditingTextElement(appState);
  if (!base) return;

  const ta = findVisibleExcalidrawTextarea(container);
  const live = ta?.value != null ? ta.value : String(base.text ?? "");

  let patchedText: Record<string, unknown> = { ...base, text: live, originalText: live };
  if (ta) {
    const sceneBox = textareaClientRectToSceneBounds(ta, appState);
    if (sceneBox) {
      const bw = Number(base.width ?? 0);
      const bh = Number(base.height ?? 0);
      patchedText = {
        ...patchedText,
        width: Math.max(bw, sceneBox.width),
        height: Math.max(bh, sceneBox.height),
      };
      const cid = patchedText.containerId;
      if (cid == null || cid === "") {
        patchedText.x = sceneBox.x;
        patchedText.y = sceneBox.y;
      }
    }
  }

  const textCanvas = await exportTextPatchCanvas(api, appState, patchedText);
  if (!textCanvas) return;

  const pw = out.width;
  const ph = out.height;
  const cssRect = ta
    ? textareaDestRectCss(container, ta)
    : approxTextBoxViewportCss(patchedText, appState);
  const { dx, dy, dw, dh } = cssRectToCanvasPixels(cssRect, cssW, cssH, pw, ph);

  if (!(dw >= 2 && dh >= 2)) return;

  const ctx = out.getContext("2d");
  if (!ctx) return;

  drawTextExportContainTopLeft(ctx, textCanvas, dx, dy, dw, dh);
}
