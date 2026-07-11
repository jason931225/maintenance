import type { components } from "@maintenance/api-client-ts";
import { describe, expect, it } from "vitest";

import { aggregateFixity, aggregateTsa } from "./evidenceApi";

type EvidenceCopyView = components["schemas"]["EvidenceCopyView"];
type TimestampAuthorityProofView = components["schemas"]["TimestampAuthorityProofView"];

// Only worm_status / status feed the aggregators, so a minimal cast keeps the
// fail-closed intent front and centre (including the deliberately out-of-enum
// value that the runtime must still treat as indeterminate).
function copy(wormStatus: string): EvidenceCopyView {
  return { worm_status: wormStatus } as unknown as EvidenceCopyView;
}

function proof(status: string): TimestampAuthorityProofView {
  return { status } as unknown as TimestampAuthorityProofView;
}

describe("aggregateFixity (fail-closed)", () => {
  it("returns PENDING for no copies — nothing to verify is never green", () => {
    expect(aggregateFixity([])).toBe("PENDING");
  });

  it("returns VERIFIED only when every copy is explicitly VERIFIED", () => {
    expect(aggregateFixity([copy("VERIFIED"), copy("VERIFIED")])).toBe("VERIFIED");
  });

  it("stays PENDING when any copy is still PENDING", () => {
    expect(aggregateFixity([copy("VERIFIED"), copy("PENDING")])).toBe("PENDING");
  });

  it("taints to MISMATCH on any FAILED copy", () => {
    expect(aggregateFixity([copy("VERIFIED"), copy("FAILED")])).toBe("MISMATCH");
  });

  it("treats an unrecognized worm_status as indeterminate (PENDING), never VERIFIED", () => {
    expect(aggregateFixity([copy("SEALED_SOMEHOW")])).toBe("PENDING");
  });
});

describe("aggregateTsa (fail-closed)", () => {
  it("returns MISSING when there are no proofs", () => {
    expect(aggregateTsa([])).toBe("MISSING");
  });

  it("returns VERIFIED only when every proof is explicitly VERIFIED", () => {
    expect(aggregateTsa([proof("VERIFIED"), proof("VERIFIED")])).toBe("VERIFIED");
  });

  it("stays PENDING when any proof is PENDING or MISSING", () => {
    expect(aggregateTsa([proof("VERIFIED"), proof("PENDING")])).toBe("PENDING");
    expect(aggregateTsa([proof("VERIFIED"), proof("MISSING")])).toBe("PENDING");
  });

  it("surfaces terminal-bad states with priority", () => {
    expect(aggregateTsa([proof("VERIFIED"), proof("FAILED")])).toBe("FAILED");
    expect(aggregateTsa([proof("VERIFIED"), proof("REVOKED")])).toBe("REVOKED");
    expect(aggregateTsa([proof("VERIFIED"), proof("EXPIRED_CA")])).toBe("EXPIRED_CA");
  });

  it("treats an unrecognized proof status as indeterminate (PENDING), never VERIFIED", () => {
    expect(aggregateTsa([proof("SOMETHING_NEW")])).toBe("PENDING");
  });
});
