import { describe, expect, it } from "vitest";

import { kindFromCode, workOrderCode, type ObjectKind } from "./objectRegistry";
import { parseTokenGrammar, serializeTokenSpans, type TokenSpan } from "./tokenGrammar";

describe("parseTokenGrammar", () => {
  it("parses a mention at line start", () => {
    expect(parseTokenGrammar("@홍길동 확인 부탁")).toEqual([
      { kind: "mention", raw: "@홍길동", value: "홍길동" },
      { kind: "text", value: " 확인 부탁" },
    ]);
  });

  it("parses an object link with a Korean search term", () => {
    expect(parseTokenGrammar("작업 #작업지시 확인")).toEqual([
      { kind: "text", value: "작업 " },
      { kind: "objectLink", raw: "#작업지시", value: "작업지시" },
      { kind: "text", value: " 확인" },
    ]);
  });

  it("parses a code link", () => {
    expect(parseTokenGrammar("승인 요청 !AP-3121 참고")).toEqual([
      { kind: "text", value: "승인 요청 " },
      { kind: "codeLink", raw: "!AP-3121", value: "AP-3121" },
      { kind: "text", value: " 참고" },
    ]);
  });

  it("parses !WO-2643 as a code link", () => {
    expect(parseTokenGrammar("!WO-2643")).toEqual([
      { kind: "codeLink", raw: "!WO-2643", value: "WO-2643" },
    ]);
  });

  // Real objects issue two-segment date-sequence codes, not just the
  // single-segment "AP-3121" shape — these must parse too (regression for the
  // codex round-2 finding: CODE_LINK_RE originally split "!WO-20260612-001"
  // into a codeLink "!WO-20260612" plus stray text "-001").
  it("parses a real two-segment work-order code (WO-{request_no})", () => {
    const code = workOrderCode("20260612-001");
    expect(parseTokenGrammar(`상태 확인 !${code} 부탁`)).toEqual([
      { kind: "text", value: "상태 확인 " },
      { kind: "codeLink", raw: `!${code}`, value: code },
      { kind: "text", value: " 부탁" },
    ]);
  });

  it("parses a real two-segment journal code (JL-{date}-{seq})", () => {
    expect(parseTokenGrammar("!JL-20260704-1")).toEqual([
      { kind: "codeLink", raw: "!JL-20260704-1", value: "JL-20260704-1" },
    ]);
  });

  it("parses multiple tokens and preserves surrounding punctuation/whitespace exactly", () => {
    expect(parseTokenGrammar("@이운창 확인, (@정비팀) 공유")).toEqual([
      { kind: "mention", raw: "@이운창", value: "이운창" },
      { kind: "text", value: " 확인, (" },
      { kind: "mention", raw: "@정비팀", value: "정비팀" },
      { kind: "text", value: ") 공유" },
    ]);
  });

  // --- Inertness (DESIGN.md §4.7-7) -----------------------------------------

  it("does not treat an email local-part @ as a mention trigger", () => {
    expect(parseTokenGrammar("ops@example.com 에게 메일")).toEqual([
      { kind: "text", value: "ops@example.com 에게 메일" },
    ]);
  });

  it("does not treat a mid-word @ as a mention trigger even with a name-shaped suffix", () => {
    expect(parseTokenGrammar("send to a@b.com now")).toEqual([
      { kind: "text", value: "send to a@b.com now" },
    ]);
  });

  it("does not treat pure-numeric #23 as an object link", () => {
    expect(parseTokenGrammar("이슈 #23 확인해줘")).toEqual([
      { kind: "text", value: "이슈 #23 확인해줘" },
    ]);
  });

  it("does not treat !! or trailing punctuation as a code link", () => {
    expect(parseTokenGrammar("주의!! 확인 필요!")).toEqual([
      { kind: "text", value: "주의!! 확인 필요!" },
    ]);
  });

  it("does not treat a code-shaped word without the ! trigger as a code link", () => {
    expect(parseTokenGrammar("참조: AP-3121 문서")).toEqual([
      { kind: "text", value: "참조: AP-3121 문서" },
    ]);
  });

  it("leaves an unmatched trailing trigger character as plain text", () => {
    expect(parseTokenGrammar("문의사항 있으면 @")).toEqual([
      { kind: "text", value: "문의사항 있으면 @" },
    ]);
  });

  it("returns a single text span for text with no triggers at all", () => {
    expect(parseTokenGrammar("아무 트리거도 없는 평범한 문장입니다.")).toEqual([
      { kind: "text", value: "아무 트리거도 없는 평범한 문장입니다." },
    ]);
  });

  it("returns a single empty text span for empty input", () => {
    expect(parseTokenGrammar("")).toEqual([{ kind: "text", value: "" }]);
  });

  // --- Round-trip -------------------------------------------------------------

  it.each([
    "@홍길동 #작업지시 !AP-3121 확인",
    "ops@example.com 관련 #23 !! 주의",
    "(@정비팀) 공유 — !WO-2643",
    "아무 트리거도 없는 문장",
    "",
  ])("serializeTokenSpans(parseTokenGrammar(text)) round-trips exactly: %j", (text) => {
    expect(serializeTokenSpans(parseTokenGrammar(text))).toBe(text);
  });

  // Hand-rolled generator (no fast-check dep) over every registry kind's real
  // code shape — catches the class of bug where the parser only handles the
  // shape of the *example* code in the spec, not the shapes objects actually
  // issue (e.g. two-segment date-sequence codes).
  it.each([
    ["approval", "AP-3121"],
    ["workOrder", workOrderCode("20260612-001")],
    ["attendance", "AT-12"],
    ["payroll", "PS-202607"],
    ["contract", "C-55"],
    ["journal", "JL-20260704-1"],
    ["intake", "IN-7"],
  ] satisfies Array<[ObjectKind, string]>)(
    "!%s round-trips and resolves back to its own kind via kindFromCode",
    (kind, code) => {
      const text = `참고 !${code} 확인`;
      const spans = parseTokenGrammar(text);
      const codeLink = spans.find((span) => span.kind === "codeLink");

      expect(codeLink).toEqual({ kind: "codeLink", raw: `!${code}`, value: code });
      expect(serializeTokenSpans(spans)).toBe(text);
      expect(kindFromCode(code)).toBe(kind);
    },
  );

  it("serializeTokenSpans reassembles arbitrary spans in order", () => {
    const spans: TokenSpan[] = [
      { kind: "text", value: "보고: " },
      { kind: "codeLink", raw: "!AP-3121", value: "AP-3121" },
      { kind: "text", value: " / " },
      { kind: "mention", raw: "@홍길동", value: "홍길동" },
    ];
    expect(serializeTokenSpans(spans)).toBe("보고: !AP-3121 / @홍길동");
  });
});
