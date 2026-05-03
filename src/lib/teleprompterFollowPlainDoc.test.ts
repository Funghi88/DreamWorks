import { describe, expect, it } from "vitest";
import { collapseBlankLines } from "@/lib/teleprompterMarkdown";
import { displayScriptToFollowPlainDoc } from "@/lib/teleprompterFollowPlainDoc";
import { scriptIndexToPlainTextOffset } from "@/lib/teleprompterFollowPlainMap";

describe("teleprompterFollowPlainDoc", () => {
  it("plain doc matches scriptIndexToPlainTextOffset expectations (heading strip)", () => {
    const md = collapseBlankLines("# 标题\n\n你好世界。");
    const plain = displayScriptToFollowPlainDoc(md);
    expect(plain).toBe("标题\n\n你好世界。");
    const readMid = 4;
    const mapped = scriptIndexToPlainTextOffset(md, readMid, plain, "zh");
    expect(mapped).toBeGreaterThan(0);
  });
});
