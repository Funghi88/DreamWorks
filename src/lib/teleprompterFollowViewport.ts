/**
 * Map viewport read-band center → script character index (follow overlay DOM).
 * DOM: [data-follow-read-span …][cursor][data-follow-rest-span text]
 * Read span may contain nested spans (per-char karaoke); rest should stay one text node when possible.
 */

function caretTextAtPoint(x: number, y: number): { node: Text; offset: number } | null {
  const tryCaret = (px: number, py: number): { node: Text; offset: number } | null => {
    if (typeof document.caretPositionFromPoint === "function") {
      const pos = document.caretPositionFromPoint(px, py);
      if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) {
        return { node: pos.offsetNode as Text, offset: pos.offset };
      }
    }
    const doc = document as Document & { caretRangeFromPoint?: (ax: number, ay: number) => Range | null };
    const r = doc.caretRangeFromPoint?.(px, py);
    if (r?.startContainer?.nodeType === Node.TEXT_NODE) {
      return { node: r.startContainer as Text, offset: r.startOffset };
    }
    return null;
  };

  let hit = tryCaret(x, y);
  if (hit) return hit;

  /* Hitting the zero-width follow cursor span often yields an Element offsetNode — nudge or snap to nearby text. */
  const el = document.elementFromPoint(x, y);
  if (el?.hasAttribute?.("data-follow-cursor")) {
    const before = el.previousSibling;
    if (before?.nodeType === Node.TEXT_NODE) {
      const t = before as Text;
      return { node: t, offset: t.length };
    }
  }

  for (let i = 1; i <= 8; i++) {
    hit = tryCaret(x, y + i * 3) ?? tryCaret(x, y - i * 3);
    if (hit) return hit;
  }
  return null;
}

function textOffsetWithinContainer(container: Element, textNode: Text, textOffset: number): number | null {
  let acc = 0;
  const walk = (node: Node): boolean => {
    if (node === textNode) {
      acc += textOffset;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      acc += (node as Text).length;
      return false;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (walk(node.childNodes[i]!)) return true;
    }
    return false;
  };
  const ok = walk(container);
  return ok ? acc : null;
}

export function scriptCharIndexAtViewportBand(
  viewport: HTMLElement,
  readSplit: number,
  scriptLength: number,
): number | null {
  const rect = viewport.getBoundingClientRect();
  const x = rect.left + rect.width * 0.5;
  const y = rect.top + rect.height * 0.34;

  const caret = caretTextAtPoint(x, y);
  if (!caret) return null;
  const { node: textNode, offset } = caret;

  const readSpan = viewport.querySelector("[data-follow-read-span]");
  const restSpan = viewport.querySelector("[data-follow-rest-span]");
  if (!readSpan || !restSpan) return null;

  if (readSpan.contains(textNode)) {
    const local = textOffsetWithinContainer(readSpan, textNode, offset);
    if (local == null) return null;
    return Math.max(0, Math.min(local, readSplit, scriptLength));
  }
  if (restSpan.contains(textNode)) {
    const restTN = restSpan.firstChild;
    if (restTN === textNode && restTN.nodeType === Node.TEXT_NODE) {
      return Math.max(0, Math.min(readSplit + offset, scriptLength));
    }
    const local = textOffsetWithinContainer(restSpan, textNode, offset);
    if (local == null) return null;
    return Math.max(0, Math.min(readSplit + local, scriptLength));
  }

  return null;
}

/** When read/rest spans are absent (rendered Markdown), map scroll position → UTF-16 index (approximate). */
export function scriptCharIndexFromScrollRatio(viewport: HTMLElement, scriptLength: number): number {
  if (scriptLength <= 0) return 0;
  const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (maxScroll <= 0) return 0;
  const r = Math.min(1, Math.max(0, viewport.scrollTop / maxScroll));
  return Math.min(scriptLength, Math.floor(r * scriptLength));
}
