import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import {
  getTeleprompterMarkdownExtensions,
  TELEPROMPTER_EDITOR_HTML_CLASS,
} from "@/lib/teleprompterTiptapExtensions";
import { collapseBlankLines } from "@/lib/teleprompterMarkdown";

export type TeleprompterScriptEditorHandle = {
  getMarkdown: () => string;
};

type Props = {
  value: string;
  activeScriptId: string;
  height: number;
  className?: string;
  placeholder?: string;
  onChange: (markdown: string) => void;
  onDebouncedCommit: (markdown: string) => void;
  debounceMs?: number;
  onScroll?: (ratio: number) => void;
  /** Sync markdown to parent when editor loses focus (matches former textarea blur). */
  onBlurCommit?: () => void;
};

export const TeleprompterScriptEditor = forwardRef<TeleprompterScriptEditorHandle, Props>(
  function TeleprompterScriptEditor(
    {
      value,
      activeScriptId,
      height,
      className,
      placeholder = "Paste script here…",
      onChange,
      onDebouncedCommit,
      debounceMs = 120,
      onScroll,
      onBlurCommit,
    },
    ref
  ) {
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevActiveIdRef = useRef(activeScriptId);

    const flushDebounce = useCallback(() => {
      if (debounceRef.current != null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }, []);

    const editor = useEditor({
      immediatelyRender: false,
      extensions: getTeleprompterMarkdownExtensions({ placeholder }),
      content: value,
      contentType: "markdown",
      editorProps: {
        attributes: {
          class: className ?? TELEPROMPTER_EDITOR_HTML_CLASS,
        },
        handlePaste: (view, event) => {
          const pasted = event.clipboardData?.getData("text/plain");
          if (pasted && /\n\n/.test(pasted)) {
            event.preventDefault();
            const cleaned = collapseBlankLines(pasted);
            const { from, to } = view.state.selection;
            view.dispatch(view.state.tr.insertText(cleaned, from, to));
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        const md = ed.getMarkdown();
        onChange(md);
        if (debounceRef.current != null) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          onDebouncedCommit(ed.getMarkdown());
        }, debounceMs);
      },
    });

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => editor?.getMarkdown() ?? "",
      }),
      [editor]
    );

    useEffect(() => () => flushDebounce(), [flushDebounce]);

    useEffect(() => {
      if (!editor) return;
      const switched = prevActiveIdRef.current !== activeScriptId;
      prevActiveIdRef.current = activeScriptId;
      if (switched) {
        editor.commands.setContent(value, { contentType: "markdown" });
        return;
      }
      const dom = editor.view.dom;
      const focused = document.activeElement === dom || dom.contains(document.activeElement);
      if (focused) return;
      const cur = editor.getMarkdown();
      if (cur !== value) {
        editor.commands.setContent(value, { contentType: "markdown" });
      }
    }, [activeScriptId, value, editor]);

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          flushDebounce();
          if (editor) onDebouncedCommit(editor.getMarkdown());
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [editor, flushDebounce, onDebouncedCommit]);

    const onScrollInner = useCallback(
      (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        const max = el.scrollHeight - el.clientHeight;
        if (max > 0) {
          onScroll?.(el.scrollTop / max);
        }
      },
      [onScroll]
    );

    useEffect(() => {
      if (!editor || !onBlurCommit) return;
      const dom = editor.view.dom as HTMLElement;
      const onBlur = () => onBlurCommit();
      dom.addEventListener("blur", onBlur);
      return () => dom.removeEventListener("blur", onBlur);
    }, [editor, onBlurCommit]);

    if (!editor) {
      return (
        <div
          data-teleprompter-editor=""
          className="min-h-0 w-full shrink-0 overflow-y-auto rounded-md border border-white/20 bg-black/45 [color-scheme:dark]"
          style={{ height }}
        />
      );
    }

    return (
      <div
        data-teleprompter-editor=""
        className="min-h-0 w-full shrink-0 overflow-y-auto rounded-md border border-white/20 bg-black/45 [color-scheme:dark]"
        style={{ height }}
        onScroll={onScrollInner}
      >
        <EditorContent editor={editor} />
      </div>
    );
  }
);
