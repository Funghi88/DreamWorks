import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** Must match `doc.textBetween` used for follow karaoke + `docPlainTextForFollow`. */
export const FOLLOW_DOC_BLOCK_SEP = "\n\n";
export const FOLLOW_DOC_LEAF_TEXT = "\n";

const BLOCK_SEP = FOLLOW_DOC_BLOCK_SEP;
const LEAF_TEXT = FOLLOW_DOC_LEAF_TEXT;

/** Plain text length model for follow mapping — same as decoration `docEndPosForPlainOffset`. */
export function docPlainTextForFollow(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, BLOCK_SEP, LEAF_TEXT);
}

export const teleprompterFollowReadPluginKey = new PluginKey<DecorationSet>("teleprompterFollowRead");

/**
 * Map plain-text offset (same length model as editor.getText()) → max doc position
 * such that textBetween(0, pos) has length <= offset.
 */
export function docEndPosForPlainOffset(doc: PMNode, endPlainOffset: number): number {
  if (endPlainOffset <= 0) return 0;
  let lo = 0;
  let hi = doc.content.size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const t = doc.textBetween(0, mid, BLOCK_SEP, LEAF_TEXT);
    if (t.length <= endPlainOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Doc position at the **start of the first unread** plain character.
 * `plainCharsRead` uses the same length model as `endPlainOffset` for grey highlight.
 * Scroll alignment should use this (not `docEndPosForPlainOffset`), otherwise the caret
 * sits at the **end of the last grey line** and the viewport aligns the **previous** line.
 */
export function docPosAtFirstUnreadPlain(doc: PMNode, plainCharsRead: number): number {
  if (plainCharsRead <= 0) return 0;
  const plain = docPlainTextForFollow(doc);
  if (plainCharsRead >= plain.length) return doc.content.size;
  let lo = 0;
  let hi = doc.content.size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = doc.textBetween(0, mid, BLOCK_SEP, LEAF_TEXT);
    if (t.length <= plainCharsRead - 1) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(doc.content.size, lo);
}

export function buildFollowReadDecorationSet(doc: PMNode, endPlainOffset: number): DecorationSet {
  const decos: Decoration[] = [];
  if (endPlainOffset > 0) {
    const endPos = docEndPosForPlainOffset(doc, endPlainOffset);
    doc.nodesBetween(0, endPos, (node, pos) => {
      if (!node.isText || !node.text) return;
      const nodeEnd = pos + node.text.length;
      const from = pos;
      const to = Math.min(nodeEnd, endPos);
      if (from < to) {
        decos.push(Decoration.inline(from, to, { class: "dw-follow-read-muted" }));
      }
    });
  }
  return DecorationSet.create(doc, decos);
}

export const TeleprompterFollowReadHighlight = Extension.create({
  name: "teleprompterFollowReadHighlight",

  addProseMirrorPlugins() {
    const key = teleprompterFollowReadPluginKey;
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            const meta = tr.getMeta(key) as { endPlainOffset?: number } | undefined;
            if (meta && typeof meta.endPlainOffset === "number") {
              return buildFollowReadDecorationSet(tr.doc, meta.endPlainOffset);
            }
            if (tr.docChanged) {
              return oldSet.map(tr.mapping, tr.doc);
            }
            return oldSet;
          },
        },
        props: {
          decorations(state) {
            return key.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
