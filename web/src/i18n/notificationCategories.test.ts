import { describe, expect, it } from "vitest";

import { categoryLabel } from "./notificationCategories";

describe("categoryLabel", () => {
  it("localizes the bare English producer/seed keys the rail was rendering raw", () => {
    expect(categoryLabel("leave")).toBe("연차");
    expect(categoryLabel("support")).toBe("지원");
    expect(categoryLabel("finance")).toBe("재무");
    expect(categoryLabel("approval")).toBe("결재");
    expect(categoryLabel("dispatch")).toBe("배차");
    expect(categoryLabel("work")).toBe("정비");
  });

  it("passes an already-localized literal through unchanged", () => {
    expect(categoryLabel("메신저")).toBe("메신저");
    expect(categoryLabel("공지")).toBe("공지");
  });

  it("is case/space tolerant and degrades an unknown key to itself", () => {
    expect(categoryLabel(" Leave ")).toBe("연차");
    expect(categoryLabel("unknown_producer")).toBe("unknown_producer");
  });
});
