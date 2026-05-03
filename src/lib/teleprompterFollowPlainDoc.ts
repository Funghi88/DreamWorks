/**
 * Follow overlay plain doc: deterministic strip of Markdown-ish syntax so TipTap
 * `docPlainTextForFollow` stays stable (no Markdown parse / typography churn).
 * Paragraphs follow `displayScript.split("\n")` → block-joined with "\n\n" (same as PM textBetween).
 */

/** Remove common inline Markdown / markup from a single line (best-effort). */
export function stripInlineMarkdownForFollowLine(s: string): string {
  let t = s;
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  t = t.replace(/!\[([^\]]*)]\([^)]+\)/g, "$1");
  return t;
}

/** One display line → visible text for follow (headings, lists, blockquote prefix). */
export function stripMarkdownLineForFollow(line: string): string {
  const trimmed = line.trimStart();
  let rest = trimmed.replace(/^#{1,6}\s+/, "");
  rest = rest.replace(/^[-*+]\s+/, "");
  rest = rest.replace(/^\d+\.\s+/, "");
  rest = rest.replace(/^>\s?/, "");
  return stripInlineMarkdownForFollowLine(rest);
}

/** Paragraph strings for TipTap (one paragraph per display line). */
export function displayScriptToFollowPlainParagraphs(displayScript: string): string[] {
  return displayScript.split("\n").map((line) => stripMarkdownLineForFollow(line));
}

/** Plain body matching `docPlainTextForFollow` for a doc built from {@link jsonDocFromFollowPlainParagraphs}. */
export function displayScriptToFollowPlainDoc(displayScript: string): string {
  return displayScriptToFollowPlainParagraphs(displayScript).join("\n\n");
}

export function jsonDocFromFollowPlainParagraphs(paragraphs: string[]): Record<string, unknown> {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: text.length ? [{ type: "text", text }] : [],
    })),
  };
}
