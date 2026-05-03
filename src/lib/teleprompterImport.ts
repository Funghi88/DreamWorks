/** Normalize text imported from .txt / .md for the teleprompter editor (preserve paragraph breaks). */
export function normalizeTeleprompterImportedText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}
