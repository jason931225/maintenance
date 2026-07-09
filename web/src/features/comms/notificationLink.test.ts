import { describe, expect, it } from "vitest";

import { notificationRoute } from "./notificationLink";

describe("notificationRoute", () => {
  it("routes an object link through the object registry", () => {
    expect(
      notificationRoute({ type: "object", kind: "approval", id: "AP-1" }),
    ).toMatch(/^\/e-approvals\?run=/);
    expect(
      notificationRoute({ type: "object", kind: "workOrder", id: "wo-uuid" }),
    ).toBe("/work-orders/wo-uuid");
  });

  it("routes a screen link through the screen table", () => {
    expect(notificationRoute({ type: "screen", screen: "mail" })).toBe("/mail");
    expect(notificationRoute({ type: "screen", screen: "support" })).toBe("/support");
  });

  it("routes a messenger mention (messenger_thread) to the messenger page", () => {
    expect(
      notificationRoute({ type: "object", kind: "messenger_thread", id: "t-42" }),
    ).toBe("/messenger");
  });

  it("falls back to the overview for unknown kinds and screens", () => {
    expect(notificationRoute({ type: "object", kind: "mystery", id: "x" })).toBe("/");
    expect(notificationRoute({ type: "screen", screen: "nowhere" })).toBe("/");
  });
});
