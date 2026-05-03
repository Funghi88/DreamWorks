/**
 * Shared Markdown helpers for teleprompter (editor, overlay, import).
 */

/**
 * Editor body is `text-[11px]`; headings use Tailwind `text-xl` / `text-lg` / `text-base`
 * (≈20px / 18px / 16px at default theme). Overlay uses these `em` multiples of `fontSize`
 * so heading scale matches the main panel.
 */
export const TELEPROMPT_EDITOR_BODY_PX = 11;
export const TELEPROMPT_MD_H1_EM = 20 / TELEPROMPT_EDITOR_BODY_PX;
export const TELEPROMPT_MD_H2_EM = 18 / TELEPROMPT_EDITOR_BODY_PX;
export const TELEPROMPT_MD_H3_EM = 16 / TELEPROMPT_EDITOR_BODY_PX;

/**
 * Collapse Markdown-style blank lines for teleprompter display:
 *  - 3+ consecutive newlines (intentional spacing) → keep one blank line (\n\n)
 *  - exactly 2 consecutive newlines (Markdown paragraph break) → single newline (no gap)
 * Order matters: replace longer runs first, then pairs.
 */
export function collapseBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").replace(/\n\n/g, "\n");
}
