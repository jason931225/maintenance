import { describe, expect, it } from "vitest";

import { isConsoleDevelopmentPreviewEnabled } from "./developmentPreview";

describe("isConsoleDevelopmentPreviewEnabled", () => {
  it.each([undefined, "", "0", "true", "yes"])(
    "keeps normal development runs production-faithful for flag %s",
    (flag) => {
      expect(isConsoleDevelopmentPreviewEnabled({ dev: true, flag })).toBe(false);
    },
  );

  it("allows the exact local development opt-in", () => {
    expect(isConsoleDevelopmentPreviewEnabled({ dev: true, flag: "1" })).toBe(true);
  });

  it("cannot be enabled by a production build even when the flag is set", () => {
    expect(isConsoleDevelopmentPreviewEnabled({ dev: false, flag: "1" })).toBe(false);
  });
});
