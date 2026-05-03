import { Markdown } from "@tiptap/markdown";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/** Main panel: `text-[11px]`; overlay: `fontSize` comes from slider on the wrapper. */
export const TELEPROMPTER_EDITOR_HTML_CLASS =
  "prose prose-invert max-w-none min-h-[4rem] px-2 py-2 text-[11px] leading-relaxed text-white caret-white outline-none focus:outline-none [&_.ProseMirror]:min-h-[4rem] [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold [&_p]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-white/35 [&_blockquote]:pl-2 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_mark]:rounded [&_mark]:bg-amber-400/35";

/** Read-only overlay: inherit `fontSize` from parent; no 11px base class. */
export const TELEPROMPTER_OVERLAY_READONLY_CLASS =
  "prose prose-invert max-w-none min-w-0 px-2 py-2 text-center leading-relaxed text-white outline-none [&_.ProseMirror]:min-h-0 [&_.ProseMirror]:text-center [&_.ProseMirror]:outline-none [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold [&_p]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-white/35 [&_blockquote]:pl-2 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_mark]:rounded [&_mark]:bg-amber-400/35";

/** Voice-follow overlay: paragraphs only — no heading/list/code styling churn. */
export const TELEPROMPTER_OVERLAY_READONLY_PLAIN_CLASS =
  "prose prose-invert max-w-none min-w-0 px-2 py-2 text-center leading-relaxed text-white outline-none [&_.ProseMirror]:min-h-0 [&_.ProseMirror]:text-center [&_.ProseMirror]:outline-none [&_p]:my-1";

/**
 * Minimal TipTap for follow overlay — no Markdown / Typography / Highlight.
 * Content is set as JSON paragraphs built from {@link displayScriptToFollowPlainParagraphs}.
 */
export function getTeleprompterFollowPlainExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
    }),
  ];
}

/** Same Markdown model for main panel editor and read-only overlay (true render, not a separate preview pipeline). */
export function getTeleprompterMarkdownExtensions(opts?: {
  /** Omit placeholder (e.g. read-only overlay). */
  includePlaceholder?: boolean;
  placeholder?: string;
}): Extensions {
  const includePlaceholder = opts?.includePlaceholder !== false;
  const exts: Extensions = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
    }),
    Highlight.configure({ multicolor: false }),
    Typography,
  ];
  if (includePlaceholder) {
    exts.push(Placeholder.configure({ placeholder: opts?.placeholder ?? "Paste script here…" }));
  }
  exts.push(Markdown);
  return exts;
}
