import { describe, expect, it } from "vitest";

import { ko } from "../i18n/ko";
import { identityLabel, isUuid, safeLabel } from "./utils";

const UUID = "3f2e1a4d-0000-4000-8000-000000000001";

describe("isUuid", () => {
  it("detects canonical UUIDs and rejects ordinary labels", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(` ${UUID} `)).toBe(true);
    expect(isUuid("창원지점")).toBe(false);
    expect(isUuid("290")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("safeLabel", () => {
  it("returns the first human candidate", () => {
    expect(safeLabel("290", "GTS25DE")).toBe("290");
    expect(safeLabel(null, "GTS25DE")).toBe("GTS25DE");
  });

  it("never surfaces a raw UUID and falls back to a human label", () => {
    expect(safeLabel(UUID)).toBe(ko.common.unknownLabel);
    expect(safeLabel(null, UUID, "번호 없음")).toBe("번호 없음");
    expect(safeLabel(undefined, "  ")).toBe(ko.common.unknownLabel);
  });
});

describe("identityLabel", () => {
  it("prefers display name, then email, then the generic label", () => {
    expect(
      identityLabel({ display_name: "김관리", email: "a@b.com" }, "관리자"),
    ).toBe("김관리");
    expect(identityLabel({ email: "a@b.com" }, "관리자")).toBe("a@b.com");
    expect(identityLabel(undefined, "관리자")).toBe("관리자");
  });

  it("ignores a UUID-shaped display name", () => {
    expect(identityLabel({ display_name: UUID }, "관리자")).toBe("관리자");
  });
});
