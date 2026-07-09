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

describe("parseTokenGrammar — triggers fire (directive 2026-07-09: @ mentions, # channels)", () => {
  it("parses an @mention at line start", () => {
    expect(tokens("@홍길동 확인")).toEqual([{ kind: "mention", raw: "@홍길동" }]);
  });
  it("parses an @mention after whitespace, not mid-word", () => {
    expect(tokens("담당 @kim 확인")).toEqual([{ kind: "mention", raw: "@kim" }]);
  });
  it("parses an @mention after an opening bracket", () => {
    expect(tokens("(@kim)")).toEqual([{ kind: "mention", raw: "@kim" }]);
  });
  it("parses a #channel reference (Slack convention)", () => {
    expect(tokens("작업 #정비팀 확인")).toEqual([{ kind: "channel", raw: "#정비팀" }]);
  });
  it("parses a #channel whose raw is a thread-id UUID (leading digit — round-trips confirm)", () => {
    expect(tokens("#11111111-1111-4111-8111-111111111111")).toEqual([
      { kind: "channel", raw: "#11111111-1111-4111-8111-111111111111" },
    ]);
  });
  it("mentions + channels coexist on one line", () => {
    expect(tokens("@kim #정비팀 확인")).toEqual([
      { kind: "mention", raw: "@kim" },
      { kind: "channel", raw: "#정비팀" },
    ]);
  });
});

describe("parseTokenGrammar — bare-code object auto-linking (NO trigger — named acceptance)", () => {
  it("auto-links a bare WO code with no trigger character", () => {
    expect(tokens("WO-2643 배차 확인")).toEqual([{ kind: "codeLink", raw: "WO-2643" }]);
  });
  it("auto-links a bare AP code mid-sentence", () => {
    expect(tokens("결재 AP-3122 확인 요망")).toEqual([{ kind: "codeLink", raw: "AP-3122" }]);
  });
  it("auto-links a bare single-letter-prefix C code", () => {
    expect(tokens("계약 C-5 갱신")).toEqual([{ kind: "codeLink", raw: "C-5" }]);
  });
  it("auto-links a two-segment date-sequence code (WO)", () => {
    expect(tokens("정비 WO-20260612-001 참고")).toEqual([{ kind: "codeLink", raw: "WO-20260612-001" }]);
  });
  it("recognizes an unregistered-prefix shape (COVID-19) — kindFromCode gates it inert at render", () => {
    expect(tokens("COVID-19 대응")).toEqual([{ kind: "codeLink", raw: "COVID-19" }]);
  });
  it("carries the whole code (no trigger char) as the span value", () => {
    const span = parseTokenGrammar("WO-2643 확인").find((s) => s.kind === "codeLink");
    expect(span).toMatchObject({ kind: "codeLink", raw: "WO-2643", value: "WO-2643" });
  });
  it("mention + channel + bare code all coexist", () => {
    expect(tokens("@kim #정비팀 WO-2643")).toEqual([
      { kind: "mention", raw: "@kim" },
      { kind: "channel", raw: "#정비팀" },
      { kind: "codeLink", raw: "WO-2643" },
    ]);
  });
});

describe("parseTokenGrammar — plain-text non-interference (directive matrix)", () => {
  it("does NOT treat an email as a mention (@ not boundary-preceded)", () => {
    expect(tokens("example@x.com 로 보냄")).toEqual([]);
  });
  it("does NOT treat an already-formed @x.com as a mention when mid-token", () => {
    expect(tokens("user@example.com")).toEqual([]);
  });
  it("does NOT treat repeated punctuation 주의!! as any token (! trigger removed)", () => {
    expect(tokens("주의!! 확인")).toEqual([]);
  });
  it("does NOT treat a lowercase code as a bare object link (codes are UPPER-cased)", () => {
    expect(tokens("ap-3121 아님")).toEqual([]);
  });
  it("does NOT treat a phone-number-like 010-1234 as a code (prefix must be A-Z)", () => {
    expect(tokens("연락 010-1234 로")).toEqual([]);
  });
  // # mirrors @: a non-matching casual query yields a harmless span that renders
  // inert (deny-by-omission) — the dropdown just opens then dismisses gracefully,
  // never a false commit. Exactly how @23 behaves as a mention span.
  it("treats casual #23 as a (channel) span that renders inert — mirrors @", () => {
    expect(tokens("이슈 #23 참고")).toEqual([{ kind: "channel", raw: "#23" }]);
    expect(tokens("이슈 @23 참고")).toEqual([{ kind: "mention", raw: "@23" }]);
  });
  it("treats casual #해시태그 as a (channel) span that renders inert — mirrors @", () => {
    expect(tokens("#해시태그")).toEqual([{ kind: "channel", raw: "#해시태그" }]);
  });
  it("preserves the exact raw text verbatim through parse + serialize", () => {
    const text = "example@x.com #23 주의!! 그리고 @kim WO-2643";
    expect(serializeTokenSpans(parseTokenGrammar(text))).toBe(text);
  });
  it("returns a single text span for tokenless prose", () => {
    expect(parseTokenGrammar("트리거 없는 평범한 문장")).toEqual([
      { kind: "text", value: "트리거 없는 평범한 문장" },
    ]);
  });
});

describe("detectActiveTrigger — in-progress autocomplete gating (@ and # share mechanics)", () => {
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
  it("detects # with an empty query (channel dropdown opens, mirroring @)", () => {
    expect(at("#")).toEqual({ trigger: "#", start: 0, query: "" });
  });
  it("detects # with a partial channel name", () => {
    expect(at("#정")).toEqual({ trigger: "#", start: 0, query: "정" });
  });
  it("detects # for a bare-number query too — opens then dismisses gracefully (mirrors @)", () => {
    expect(at("#2")).toEqual({ trigger: "#", start: 0, query: "2" });
    expect(at("@2")).toEqual({ trigger: "@", start: 0, query: "2" });
  });
  it("does NOT detect any trigger after a lone ! (! trigger removed)", () => {
    expect(at("!WO-2026")).toBeNull();
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
