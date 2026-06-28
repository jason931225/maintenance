import { describe, expect, it } from "vitest";

import { ko } from "../../i18n/ko";
import { roleLabel } from "./org-format";

describe("roleLabel", () => {
  it("localizes built-in roles and preserves valid custom role labels", () => {
    expect(roleLabel("MECHANIC")).toBe("정비사");
    expect(roleLabel("그룹 HR 책임자")).toBe("그룹 HR 책임자");
  });

  it("does not render a raw identifier as a role label", () => {
    expect(roleLabel("00000000-0000-4000-8000-000000000001")).toBe(
      ko.common.unknownLabel,
    );
  });
});
