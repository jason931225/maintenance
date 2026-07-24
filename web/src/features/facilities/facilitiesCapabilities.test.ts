import { describe, expect, it } from "vitest";

import { deriveFacilitiesCapabilities } from "./facilitiesCapabilities";

const actor = "operator-a";
const selected = (status: string, assigneeId: string | null = actor) => ({ status, assigneeId }) as never;
const gate = (...features: string[]) => ({
  allows: ({ feature }: { feature: string }) => features.includes(feature),
});

describe("deriveFacilitiesCapabilities", () => {
  it("uses the server feature mapping and state constraints", () => {
    expect(deriveFacilitiesCapabilities(gate("facilities_dispatch"), selected("DUE"), actor)).toMatchObject({
      canTriage: true,
      canAssign: false,
      canCreate: false,
    });
    expect(deriveFacilitiesCapabilities(gate("facilities_dispatch"), selected("SCHEDULED"), actor)).toMatchObject({
      canTriage: false,
      canAssign: true,
    });
  });

  it("requires the authenticated operator to be the assignee for execution and submission", () => {
    expect(deriveFacilitiesCapabilities(gate("facilities_execute"), selected("ASSIGNED", "operator-b"), actor)).toMatchObject({
      canStart: false,
      canSubmit: false,
    });
    expect(deriveFacilitiesCapabilities(gate("facilities_execute"), selected("IN_PROGRESS"), actor)).toMatchObject({
      canStart: false,
      canSubmit: true,
    });
  });

  it("keeps observation independent from execution but still capability-gated", () => {
    expect(deriveFacilitiesCapabilities(gate("facilities_observe"), selected("IN_PROGRESS", "operator-b"), actor)).toMatchObject({
      canObserve: true,
      canSubmit: false,
    });
  });
});
