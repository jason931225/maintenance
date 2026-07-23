import { describe, expect, it } from "vitest";

import MyWorkScreen from "./mywork/MyWorkScreen";
import { SalesCrmScreenBody } from "../sales";
import { SCREEN_REGISTRY } from "./registry";

describe("SCREEN_REGISTRY", () => {
  it("mounts the authenticated My Work body instead of a blank canvas", () => {
    expect(SCREEN_REGISTRY.mywork).toBe(MyWorkScreen);
  });

  it("mounts the authenticated sales workbench instead of leaving it as dead inventory", () => {
    expect(SCREEN_REGISTRY.sales).toBe(SalesCrmScreenBody);
  });
});
