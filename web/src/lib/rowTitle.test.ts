import { describe, expect, it } from "vitest";

import { isObjectCode, resolveRowTitle } from "./rowTitle";

describe("isObjectCode", () => {
  it("recognises business/object codes", () => {
    expect(isObjectCode("20260710-004")).toBe(true); // work-order request_no
    expect(isObjectCode("20260701-001")).toBe(true); // run-log object id
    expect(isObjectCode("AP-3121")).toBe(true);
    expect(isObjectCode("WO-2643")).toBe(true);
    expect(isObjectCode("GL-2026-0001")).toBe(true);
    expect(isObjectCode("00000000-0000-0000-0000-000000a20001")).toBe(true); // uuid
  });

  it("does not flag human subject lines", () => {
    expect(isObjectCode("NK 보안 대근비 지급 요청")).toBe(false);
    expect(isObjectCode("3호기 정기점검")).toBe(false); // leads with a digit but is human
    expect(isObjectCode("결재 위임 규칙 검토")).toBe(false);
    expect(isObjectCode("")).toBe(false);
    expect(isObjectCode(undefined)).toBe(false);
  });
});

describe("resolveRowTitle", () => {
  it("keeps a human title and demotes the code to meta", () => {
    expect(resolveRowTitle("NK 보안 대근비 지급 요청", "AP-3121", "결재")).toEqual({
      title: "NK 보안 대근비 지급 요청",
      code: "AP-3121",
    });
  });

  it("promotes the fallback when the title is itself a code", () => {
    // dispatch/work rows: backend sets title === request_no === ref
    expect(resolveRowTitle("20260710-004", "20260710-004", "정비")).toEqual({
      title: "정비",
      code: "20260710-004",
    });
  });

  it("never surfaces a UUID as a code", () => {
    const uuid = "00000000-0000-0000-0000-0000005c0001";
    // human title + uuid ref (support tickets carry no human code) → no meta code
    expect(resolveRowTitle("지게차 시동 불량 문의", uuid, "회신")).toEqual({
      title: "지게차 시동 불량 문의",
      code: undefined,
    });
    // code-only title that is a uuid → fallback title, no meta code
    expect(resolveRowTitle(uuid, undefined, "회신")).toEqual({
      title: "회신",
      code: undefined,
    });
  });

  it("drops a code that merely duplicates the title", () => {
    expect(resolveRowTitle("월간 정산 보고", "월간 정산 보고", "정비").code).toBeUndefined();
  });

  it("falls back on an empty title", () => {
    expect(resolveRowTitle("", "AP-9", "결재")).toEqual({ title: "결재", code: "AP-9" });
    expect(resolveRowTitle(undefined, undefined, "결재")).toEqual({
      title: "결재",
      code: undefined,
    });
  });
});
