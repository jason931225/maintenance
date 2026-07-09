import { describe, expect, it } from "vitest";

import {
  computeDropdownPosition,
  detectActiveTrigger,
  parseTokenGrammar,
  serializeTokenSpans,
} from "./grammar";

/** Compact view of the parse result for matrix assertions. */
function tokens(text: string) {
  return parseTokenGrammar(text)
    .filter((s) => s.kind !== "text")
    .map((s) => ({ kind: s.kind, raw: (s as { raw: string }).raw }));
}

describe("parseTokenGrammar — triggers fire", () => {
  it("parses an @mention at line start", () => {
    expect(tokens("@홍길동 확인")).toEqual([{ kind: "mention", raw: "@홍길동" }]);
  });
  it("parses an @mention after whitespace, not mid-word", () => {
    expect(tokens("담당 @kim 확인")).toEqual([{ kind: "mention", raw: "@kim" }]);
  });
  it("parses an @mention after an opening bracket", () => {
    expect(tokens("(@kim)")).toEqual([{ kind: "mention", raw: "@kim" }]);
  });
  it("parses a #object-link whose term starts with a letter", () => {
    expect(tokens("작업 #정비건 확인")).toEqual([{ kind: "objectLink", raw: "#정비건" }]);
  });
  it("parses a !CODE single-segment code", () => {
    expect(tokens("승인 !AP-3121")).toEqual([{ kind: "codeLink", raw: "!AP-3121" }]);
  });
  it("parses a !CODE two-segment date-sequence code (WO)", () => {
    expect(tokens("정비 !WO-20260612-001 참고")).toEqual([{ kind: "codeLink", raw: "!WO-20260612-001" }]);
  });
  it("parses all three trigger kinds in one line", () => {
    expect(tokens("@kim #건 !AP-3121")).toEqual([
      { kind: "mention", raw: "@kim" },
      { kind: "objectLink", raw: "#건" },
      { kind: "codeLink", raw: "!AP-3121" },
    ]);
  });
});

describe("parseTokenGrammar — plain-text non-interference (spec §4.7-7)", () => {
  it("does NOT treat an email as a mention (@ not boundary-preceded)", () => {
    expect(tokens("example@x.com 로 보냄")).toEqual([]);
  });
  it("does NOT treat an already-formed @x.com as a mention when mid-token", () => {
    expect(tokens("user@example.com")).toEqual([]);
  });
  it("does NOT treat a bare numeric #23 as an object link (no leading letter)", () => {
    expect(tokens("이슈 #23 참고")).toEqual([]);
  });
  it("does NOT treat #_ (leading non-letter) as an object link", () => {
    expect(tokens("#_tmp")).toEqual([]);
  });
  it("does NOT treat repeated punctuation 주의!! as a code link", () => {
    expect(tokens("주의!! 확인")).toEqual([]);
  });
  it("does NOT treat a lowercase/malformed !code as a code link", () => {
    expect(tokens("!ap-3121 아님")).toEqual([]);
  });
  it("does NOT treat a bang before a word !확인 as a code link", () => {
    expect(tokens("!확인 요망")).toEqual([]);
  });
  it("preserves the exact raw text verbatim through parse + serialize", () => {
    const text = "example@x.com #23 주의!! 그리고 @kim !AP-3121";
    expect(serializeTokenSpans(parseTokenGrammar(text))).toBe(text);
  });
  it("returns a single text span for tokenless prose", () => {
    expect(parseTokenGrammar("트리거 없는 평범한 문장")).toEqual([
      { kind: "text", value: "트리거 없는 평범한 문장" },
    ]);
  });
});

describe("detectActiveTrigger — in-progress autocomplete gating", () => {
  const at = (text: string) => detectActiveTrigger(text, text.length);

  it("detects @ with an empty query right after the trigger", () => {
    expect(at("@")).toEqual({ trigger: "@", start: 0, query: "" });
  });
  it("detects @ with a partial name query", () => {
    expect(at("담당 @홍")).toEqual({ trigger: "@", start: 3, query: "홍" });
  });
  it("does NOT detect @ inside an email address", () => {
    expect(at("user@ex")).toBeNull();
  });
  it("does NOT detect # for a bare-number in-progress query", () => {
    expect(at("#2")).toBeNull();
  });
  it("detects # once the term starts with a letter", () => {
    expect(at("#정")).toEqual({ trigger: "#", start: 0, query: "정" });
  });
  it("detects ! for an in-progress uppercase code", () => {
    expect(at("!WO-2026")).toEqual({ trigger: "!", start: 0, query: "WO-2026" });
  });
  it("does NOT detect ! for lowercase in-progress input", () => {
    expect(at("!wo")).toBeNull();
  });
  it("returns null when the caret sits after whitespace (token closed)", () => {
    expect(at("@kim 확인")).toBeNull();
  });
  it("tracks the trigger the caret is inside when the caret is mid-string", () => {
    // caret right after "@ho" in "@ho world"
    expect(detectActiveTrigger("@ho world", 3)).toEqual({ trigger: "@", start: 0, query: "ho" });
  });
});

describe("computeDropdownPosition — viewport flip/clamp (§4.7-7)", () => {
  const vp = { width: 1000, height: 800 };

  it("places below when there is room below", () => {
    const p = computeDropdownPosition({ top: 100, bottom: 130, left: 50 }, { width: 300, height: 200 }, vp);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(130);
    expect(p.maxHeight).toBe(200);
  });

  it("flips above when below is too short and above has more room", () => {
    const p = computeDropdownPosition({ top: 700, bottom: 740, left: 50 }, { width: 300, height: 200 }, vp);
    expect(p.placement).toBe("above");
    // top = caret.top - maxHeight; clamped to >= EDGE_MARGIN
    expect(p.top).toBeLessThan(700);
    expect(p.maxHeight).toBeLessThanOrEqual(200);
  });

  it("clamps left so a right-edge caret never pushes the dropdown off-screen", () => {
    const p = computeDropdownPosition({ top: 100, bottom: 130, left: 990 }, { width: 300, height: 200 }, vp);
    // maxLeft = 1000 - 300 - 8 = 692
    expect(p.left).toBe(692);
  });

  it("shrinks maxHeight to the available space near an edge (never clips)", () => {
    const p = computeDropdownPosition({ top: 60, bottom: 770, left: 50 }, { width: 300, height: 400 }, vp);
    // below space = 800 - 770 = 30; above = 60 → picks above, available = 60 - 8 = 52
    expect(p.maxHeight).toBeLessThanOrEqual(52);
  });
});
