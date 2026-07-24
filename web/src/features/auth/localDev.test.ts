import { describe, expect, it } from "vitest";

import { isLocalDevBuild } from "./localDev";

describe("isLocalDevBuild", () => {
  it("allows only the three local DEV hostnames", () => {
    for (const hostname of ["localhost", "127.0.0.1", "::1"]) {
      expect(isLocalDevBuild(true, hostname)).toBe(true);
    }
    expect(isLocalDevBuild(true, "dev.console.example")).toBe(false);
    expect(isLocalDevBuild(false, "localhost")).toBe(false);
  });
});
