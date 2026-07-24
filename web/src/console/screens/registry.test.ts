import { describe, expect, it } from "vitest";

import { AttendanceScreenBody } from "../../features/attendance";
import MyWorkScreen from "./mywork/MyWorkScreen";
import { PeopleWorkforceBody } from "../people";
import { SalesCrmScreenBody } from "../sales";
import { InventoryScreenBody } from "../inventory/InventoryScreenBody";
import { SCREEN_REGISTRY } from "./registry";

describe("SCREEN_REGISTRY", () => {
  it("mounts the prop-less authenticated Attendance body in dark inventory", () => {
    expect(SCREEN_REGISTRY.attendance).toBe(AttendanceScreenBody);
  });

  it("mounts the authenticated My Work body instead of a blank canvas", () => {
    expect(SCREEN_REGISTRY.mywork).toBe(MyWorkScreen);
  });

  it("mounts the authenticated sales workbench instead of leaving it as dead inventory", () => {
    expect(SCREEN_REGISTRY.sales).toBe(SalesCrmScreenBody);
  });

  it("mounts the authenticated People workforce body in development inventory", () => {
    expect(SCREEN_REGISTRY.people).toBe(PeopleWorkforceBody);
  });

  it("mounts the authenticated inventory body in development inventory", () => {
    expect(SCREEN_REGISTRY.inventory).toBe(InventoryScreenBody);
  });
});
