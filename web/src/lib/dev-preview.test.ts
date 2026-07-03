import { beforeEach, describe, expect, it } from "vitest";

import { isDevPreviewEnabled } from "./dev-preview";

function setUrl(path: string) {
  window.history.pushState({}, "", path);
}

describe("isDevPreviewEnabled", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setUrl("/payroll");
  });

  it("persists the local preview flag after the opt-in query is used once", () => {
    setUrl("/payroll?dev_auto_login=on");

    expect(isDevPreviewEnabled()).toBe(true);

    setUrl("/payroll");

    expect(isDevPreviewEnabled()).toBe(true);
  });

  it("clears the local preview flag with the opt-out query", () => {
    setUrl("/payroll?dev_auto_login=on");
    expect(isDevPreviewEnabled()).toBe(true);

    setUrl("/payroll?dev_auto_login=off");
    expect(isDevPreviewEnabled()).toBe(false);

    setUrl("/payroll");
    expect(isDevPreviewEnabled()).toBe(false);
  });
});
