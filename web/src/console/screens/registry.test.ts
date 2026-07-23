import { describe, expect, it } from "vitest";

import MyWorkScreen from "./mywork/MyWorkScreen";
import { SCREEN_REGISTRY } from "./registry";

describe("SCREEN_REGISTRY", () => {
  it("mounts the authenticated My Work body instead of a blank canvas", () => {
    expect(SCREEN_REGISTRY.mywork).toBe(MyWorkScreen);
  });
});
