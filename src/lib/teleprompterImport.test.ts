import { describe, expect, it } from "vitest";
import { normalizeTeleprompterImportedText } from "./teleprompterImport";

describe("normalizeTeleprompterImportedText", () => {
  it("normalizes CRLF and collapses 3+ newlines without removing paragraph breaks", () => {
    const raw = "Line1\r\n\r\nLine2\n\n\n\nLine3";
    expect(normalizeTeleprompterImportedText(raw)).toBe("Line1\n\nLine2\n\nLine3");
  });
});
