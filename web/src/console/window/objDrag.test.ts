import { describe, expect, it } from "vitest";

import {
  OBJ_REF_MIME,
  objDrag,
  objectRefToken,
  parseObjectRef,
  parseObjectRefText,
  writeObjectRef,
} from "./objDrag";

// jsdom has no DataTransfer; a Map-backed stub covers the getData/setData/types
// surface objDrag touches.
function mockDataTransfer(seed: Record<string, string> = {}): DataTransfer {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    setData: (format: string, value: string) => void store.set(format, value),
    getData: (format: string) => store.get(format) ?? "",
    get types() {
      return [...store.keys()];
    },
    dropEffect: "none",
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

describe("objDrag", () => {
  it("writes both the typed mime and the text/plain token on dragStart", () => {
    const dataTransfer = mockDataTransfer();
    const props = objDrag("WO-2643", "4호기 유압 점검");
    expect(props.draggable).toBe(true);
    expect(props["data-obj-code"]).toBe("WO-2643");

    props.onDragStart({ dataTransfer } as unknown as Parameters<typeof props.onDragStart>[0]);

    expect(dataTransfer.getData(OBJ_REF_MIME)).toBe(
      JSON.stringify({ code: "WO-2643", title: "4호기 유압 점검" }),
    );
    expect(dataTransfer.getData("text/plain")).toBe("[WO-2643 4호기 유압 점검]");
  });

  it("round-trips through the typed mime", () => {
    const dataTransfer = mockDataTransfer();
    writeObjectRef(dataTransfer, { code: "AP-91", title: "구매 기안" });
    expect(parseObjectRef(dataTransfer)).toEqual({ code: "AP-91", title: "구매 기안" });
  });

  it("falls back to the text/plain token when no typed mime is present", () => {
    const dataTransfer = mockDataTransfer({ "text/plain": objectRefToken("WO-2643", "유압 점검") });
    expect(parseObjectRef(dataTransfer)).toEqual({ code: "WO-2643", title: "유압 점검" });
  });

  it("recovers a bare code with no title from plain text", () => {
    expect(parseObjectRefText("보고: WO-2643 확인 바랍니다")).toEqual({
      code: "WO-2643",
      title: "WO-2643",
    });
  });

  it("returns null for a plain-text non-token string", () => {
    expect(parseObjectRefText("그냥 평범한 문장입니다")).toBeNull();
    expect(parseObjectRef(mockDataTransfer({ "text/plain": "hello world" }))).toBeNull();
  });

  it("falls through to text/plain when the typed payload is malformed", () => {
    const dataTransfer = mockDataTransfer({
      [OBJ_REF_MIME]: "{not json",
      "text/plain": "[CS-7 계약 검토]",
    });
    expect(parseObjectRef(dataTransfer)).toEqual({ code: "CS-7", title: "계약 검토" });
  });

  // Prefixes shipped by later surfaces that must round-trip through the grammar:
  // EV- (evidence), OT-/SR- (ontology types & series cards), PAY- (payroll node),
  // EQ- (equipment/config objects), VC-/FL-/HR-/TK- (finance/equipment/employee/ticket modules).
  it.each([
    ["EV-2026-00012", "감사 증거"],
    ["OT-FINANCE", "전표 유형"],
    ["SR-205", "급여 시리즈"],
    ["PAY-CHO", "조 급여"],
    ["EQ-118", "3호기 지게차"],
    ["VC-4410", "6월 전표"],
    ["FL-118", "지게차"],
    ["HR-2043", "김현장"],
    ["TK-9001", "점검 요청"],
  ])("round-trips the %s object code through a dropped token", (code, title) => {
    const dataTransfer = mockDataTransfer({ "text/plain": objectRefToken(code, title) });
    expect(parseObjectRef(dataTransfer)).toEqual({ code, title });
    // bare code (no bracket) also recovers, matching renderMessageParts extraction
    expect(parseObjectRefText(`참고: ${code} 확인`)).toEqual({ code, title: code });
  });
});
