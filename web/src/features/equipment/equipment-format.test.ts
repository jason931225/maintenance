import { describe, expect, it } from "vitest";

import { equipmentStatusBadgeClass } from "./equipment-format";

describe("equipment format", () => {
  it("maps equipment statuses to semantic tone classes", () => {
    expect(equipmentStatusBadgeClass("rented")).toBe(
      "border-tone-accent-border bg-tone-accent-bg text-tone-accent-text",
    );
    expect(equipmentStatusBadgeClass("spare")).toBe(
      "border-tone-neutral-border bg-tone-neutral-bg text-tone-neutral-text",
    );
    expect(equipmentStatusBadgeClass("disposed")).toBe(
      "border-tone-danger-border bg-tone-danger-bg text-tone-danger-text",
    );
    expect(equipmentStatusBadgeClass("replacement")).toBe(
      "border-tone-info-border bg-tone-info-bg text-tone-info-text",
    );
    expect(equipmentStatusBadgeClass("sold")).toBe(
      "border-tone-success-border bg-tone-success-bg text-tone-success-text",
    );
  });
});
