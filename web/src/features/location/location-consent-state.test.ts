import { describe, expect, it } from "vitest";

import {
  applyLocationConsentEvent,
  mayCollectGps,
} from "./location-consent-state";

describe("location consent state", () => {
  it("keeps the GPS off switch available as an immediate suspension", () => {
    expect(applyLocationConsentEvent("GRANTED", "suspend")).toBe("SUSPENDED");
    expect(mayCollectGps("SUSPENDED", true)).toBe(false);
  });

  it("requires both granted consent and on-duty state before collection", () => {
    expect(mayCollectGps("GRANTED", true)).toBe(true);
    expect(mayCollectGps("GRANTED", false)).toBe(false);
    expect(mayCollectGps("NO_RECORD", true)).toBe(false);
    expect(mayCollectGps("WITHDRAWN", true)).toBe(false);
  });

  it("withdraws from active or suspended consent into a non-collecting state", () => {
    expect(applyLocationConsentEvent("GRANTED", "withdraw")).toBe("WITHDRAWN");
    expect(applyLocationConsentEvent("SUSPENDED", "withdraw")).toBe(
      "WITHDRAWN",
    );
    expect(mayCollectGps("WITHDRAWN", true)).toBe(false);
  });
});
