import { describe, expect, it } from "vitest";
import {
  followScrollFraction,
  normKeyLenForFollow,
  readCharsForFollowScrollFraction,
  readCharsForPlainTextOffset,
  scriptIndexToPlainTextOffset,
} from "./teleprompterFollowPlainMap";

describe("teleprompterFollowPlainMap", () => {
  it("zh: plain offset tracks normalized script prefix, not linear ratio", () => {
    const md = "# 标题\n\n你好世界。";
    const plain = "标题\n\n你好世界。";
    /* readMid=5 happens to equal linear & mapped (both 4); use 4 so linear (3) ≠ mapped (4). */
    const readMid = 4;
    const linear = Math.floor((readMid / md.length) * plain.length);
    const mapped = scriptIndexToPlainTextOffset(md, readMid, plain, "zh");
    expect(linear).not.toBe(mapped);
    expect(mapped).toBeGreaterThan(0);
    expect(normKeyLenForFollow(plain.slice(0, mapped), "zh")).toBeLessThanOrEqual(
      normKeyLenForFollow(md.slice(0, readMid), "zh"),
    );
  });

  it("followScrollFraction uses norm progress", () => {
    const md = "abc\ndef";
    const f = followScrollFraction(md, 2, "en");
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThanOrEqual(1);
  });

  it("followScrollFraction is non-decreasing in readChars (mixed digits + CJK + Latin)", () => {
    const md =
      "第1章 前言\n\n在 2024 年我们发布了 Dreamwork v2，OK 与 API 对齐。\n\n详见 section 3。";
    let prev = -1;
    for (const lang of ["zh", "en"] as const) {
      prev = -1;
      for (let c = 0; c <= md.length; c++) {
        const f = followScrollFraction(md, c, lang);
        expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
  });

  it("readCharsForPlainTextOffset inverts scriptIndexToPlainTextOffset (zh heading)", () => {
    const md = "# 标题\n\n你好世界。";
    const plain = "标题\n\n你好世界。";
    for (const c of [0, 2, 4, 8, md.length]) {
      const off = scriptIndexToPlainTextOffset(md, c, plain, "zh");
      const back = readCharsForPlainTextOffset(md, off, plain, "zh");
      const off2 = scriptIndexToPlainTextOffset(md, back, plain, "zh");
      expect(off2).toBeLessThanOrEqual(off);
      expect(Math.abs(off2 - off)).toBeLessThan(4);
    }
  });

  it("readCharsForFollowScrollFraction inverts followScrollFraction (roundtrip)", () => {
    const md = "# Hello\n\nWorld test.";
    for (const lang of ["zh", "en"] as const) {
      for (const c of [0, 3, 12, Math.floor(md.length / 2), md.length]) {
        const frac = followScrollFraction(md, c, lang);
        const back = readCharsForFollowScrollFraction(md, frac, lang);
        const frac2 = followScrollFraction(md, back, lang);
        expect(Math.abs(frac2 - frac)).toBeLessThan(0.02);
      }
    }
  });
});
