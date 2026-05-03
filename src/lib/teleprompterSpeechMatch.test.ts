import { describe, expect, it } from "vitest";
import {
  matchReadEnd,
  normalizeForSpeechMatch,
  normCompactEndToScriptIndex,
  normEndToScriptIndex,
  scriptHasMixedZhEn,
} from "./teleprompterSpeechMatch";

describe("scriptHasMixedZhEn", () => {
  it("detects Latin + CJK", () => {
    expect(scriptHasMixedZhEn("你好 hello")).toBe(true);
    expect(scriptHasMixedZhEn("API 接口")).toBe(true);
  });

  it("false for single script", () => {
    expect(scriptHasMixedZhEn("只有中文")).toBe(false);
    expect(scriptHasMixedZhEn("english only")).toBe(false);
  });
});

describe("normalizeForSpeechMatch", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeForSpeechMatch("Hello, World!")).toBe("hello world");
  });

  it("keeps CJK", () => {
    expect(normalizeForSpeechMatch("你好，世界。")).toBe("你好世界");
  });
});

describe("normEndToScriptIndex", () => {
  it("maps norm length to script offset (trailing punctuation may not advance index)", () => {
    const script = "Hi, Ann!";
    const n = normalizeForSpeechMatch(script).length;
    expect(normEndToScriptIndex(script, n)).toBe(7);
  });
});

describe("normCompactEndToScriptIndex", () => {
  it("maps compact norm length across spaced CJK", () => {
    const script = "我 们 去";
    const compactLen = normalizeForSpeechMatch(script).replace(/ /g, "").length;
    expect(normCompactEndToScriptIndex(script, compactLen)).toBe(script.length);
  });
});

describe("matchReadEnd", () => {
  it("advances on English suffix match", () => {
    const script = "one two three four five";
    const spoken = "one two three";
    const end = matchReadEnd(script, spoken, 0);
    expect(end).toBeGreaterThan(0);
    expect(script.slice(0, end).toLowerCase()).toContain("three");
  });

  it("monotonic advance", () => {
    const script = "alpha beta gamma delta";
    const a = matchReadEnd(script, "alpha beta", 0);
    const b = matchReadEnd(script, "alpha beta gamma", a);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("multi-line English script", () => {
    const script = "Hook line.\nMain point one.";
    expect(matchReadEnd(script, "hook line", 0)).toBeGreaterThan(0);
  });

  it("two-character CJK phrase can advance", () => {
    const script = "你好世界";
    expect(matchReadEnd(script, "你好", 0)).toBeGreaterThan(0);
  });

  it("maxNormAdvance caps how far a single match can jump", () => {
    const script = "abcdefghijklmnopqrstuvwxyz";
    const end = matchReadEnd(script, "abcdefghijklm", 0, {
      minTailLen: 2,
      maxNormAdvance: 5,
      allowGlobalFallback: true,
    });
    const normEnd = normalizeForSpeechMatch(script.slice(0, end)).length;
    expect(normEnd).toBeLessThanOrEqual(5);
  });

  it("preferClosestScriptEnd advances to the closest occurrence among duplicates ahead", () => {
    const script = "今天很好今天很冷今天下雨";
    const afterFirst = matchReadEnd(script, "今天很好", 0, {
      minTailLen: 2,
      maxNormAdvance: 80,
      allowGlobalFallback: false,
    });
    const nearest = matchReadEnd(script, "今天很冷", afterFirst, {
      minTailLen: 2,
      maxNormAdvance: 80,
      allowGlobalFallback: false,
      onlyMatchAhead: true,
      onlyAheadSlackNorm: 8,
      preferClosestScriptEnd: true,
    });
    expect(nearest).toBeGreaterThan(afterFirst);
    expect(script.slice(afterFirst, nearest)).toContain("今天很冷");
  });

  it("longScriptMatchLookbackChars does not break basic closest match", () => {
    const end = matchReadEnd("hello world today", "world", 3, {
      minTailLen: 2,
      maxNormAdvance: 50,
      allowGlobalFallback: false,
      preferClosestScriptEnd: true,
      longScriptMatchLookbackChars: 8,
    });
    expect(end).toBeGreaterThan(3);
  });

  it("matchIgnoreSpaces + preferClosest aligns spaced script with ASR-like spoken", () => {
    const script = "我们 今天 一起去公园";
    const end = matchReadEnd(script, "我们今天一起去", 0, {
      minTailLen: 4,
      maxNormAdvance: 80,
      allowGlobalFallback: false,
      onlyMatchAhead: true,
      matchIgnoreSpaces: true,
      preferClosestScriptEnd: true,
    });
    expect(end).toBeGreaterThan(0);
    expect(normalizeForSpeechMatch(script.slice(0, end)).replace(/ /g, "")).toContain("我们今天一起去");
  });

  it("onlyMatchAhead ignores duplicate phrases before the read head", () => {
    const script = "今天很好今天很热今天下雨";
    const afterFirst = matchReadEnd(script, "今天很好", 0, {
      minTailLen: 2,
      maxNormAdvance: 40,
      allowGlobalFallback: false,
    });
    expect(afterFirst).toBeGreaterThan(0);
    const withAhead = matchReadEnd(script, "今天很热", afterFirst, {
      minTailLen: 2,
      maxNormAdvance: 40,
      allowGlobalFallback: false,
      onlyMatchAhead: true,
      onlyAheadSlackNorm: 0,
    });
    const withoutAhead = matchReadEnd(script, "今天很热", afterFirst, {
      minTailLen: 2,
      maxNormAdvance: 40,
      allowGlobalFallback: false,
      onlyMatchAhead: false,
      anchorLookback: 200,
    });
    expect(withAhead).toBeGreaterThanOrEqual(afterFirst);
    expect(withoutAhead).toBeGreaterThanOrEqual(afterFirst);
    expect(withAhead).toBeLessThanOrEqual(withoutAhead);
  });

  it("allowLooseTailFallback advances when minTailLen 3 finds no hit but 2-char tail matches", () => {
    const script = "abcdefghij";
    const prevEnd = 5;
    const spoken = "abcdfg";
    const strict = matchReadEnd(script, spoken, prevEnd, {
      minTailLen: 3,
      allowGlobalFallback: false,
      onlyMatchAhead: true,
      onlyAheadSlackNorm: 10,
      preferClosestScriptEnd: true,
    });
    const loose = matchReadEnd(script, spoken, prevEnd, {
      minTailLen: 3,
      allowGlobalFallback: false,
      onlyMatchAhead: true,
      onlyAheadSlackNorm: 10,
      preferClosestScriptEnd: true,
      allowLooseTailFallback: true,
    });
    expect(strict).toBe(prevEnd);
    expect(loose).toBeGreaterThan(prevEnd);
  });

  it("allowLooseTailFallback works on pickNearest path (EN partials)", () => {
    /* Same drift as preferClosest loose test: minTail 3 finds no hit; minTail 2 retry advances. */
    const script = "abcdefghij";
    const prevEnd = 5;
    const spoken = "abcdfg";
    const strict = matchReadEnd(script, spoken, prevEnd, {
      minTailLen: 3,
      allowGlobalFallback: false,
      onlyMatchAhead: true,
      onlyAheadSlackNorm: 10,
      pickNearestMatch: true,
    });
    const loose = matchReadEnd(script, spoken, prevEnd, {
      minTailLen: 3,
      allowGlobalFallback: false,
      onlyMatchAhead: true,
      onlyAheadSlackNorm: 10,
      pickNearestMatch: true,
      allowLooseTailFallback: true,
    });
    expect(strict).toBe(prevEnd);
    expect(loose).toBeGreaterThan(prevEnd);
  });
});
