import { describe, expect, it } from "vitest";

import {
  deriveLogisticsCapabilities,
  type LogisticsFeature,
  type LogisticsPolicyGate,
} from "./logisticsCapabilities";

function gateFor(granted: LogisticsFeature[], branch = "branch-1"): LogisticsPolicyGate {
  return {
    allows: (query) => query.branch === branch && granted.includes(query.feature),
  };
}

describe("deriveLogisticsCapabilities", () => {
  it("denies everything when no logistics feature is granted", () => {
    const capabilities = deriveLogisticsCapabilities(gateFor([]), "branch-1");
    expect(capabilities).toEqual({
      canRead: false,
      canReceive: false,
      canPutaway: false,
      canRelease: false,
      canPickPack: false,
      canDispatch: false,
      canPod: false,
      canSettle: false,
    });
  });

  it("maps each grant-only feature to exactly its capability", () => {
    const capabilities = deriveLogisticsCapabilities(
      gateFor(["logistics_receive", "logistics_pod"]),
      "branch-1",
    );
    expect(capabilities.canRead).toBe(true);
    expect(capabilities.canReceive).toBe(true);
    expect(capabilities.canPod).toBe(true);
    expect(capabilities.canPutaway).toBe(false);
    expect(capabilities.canRelease).toBe(false);
    expect(capabilities.canPickPack).toBe(false);
    expect(capabilities.canDispatch).toBe(false);
    expect(capabilities.canSettle).toBe(false);
  });

  it("fails closed for a branch outside the capability scope", () => {
    const capabilities = deriveLogisticsCapabilities(
      gateFor(["logistics_receive"], "branch-1"),
      "branch-2",
    );
    expect(capabilities.canRead).toBe(false);
    expect(capabilities.canReceive).toBe(false);
  });
});
