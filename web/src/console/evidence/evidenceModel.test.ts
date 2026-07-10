import { describe, expect, it } from "vitest";

import {
  admissibilityTone,
  custodyStageOfAudit,
  derivativesOf,
  formatSize,
  holdActive,
  originalOf,
  shortDigest,
  toObjectCardDescriptor,
} from "./evidenceModel";
import { evidenceFixtures } from "./evidenceFixtures";
import type { EvidenceLegalHold } from "./types";

describe("custodyStageOfAudit", () => {
  it("maps the EV audit actions to custody stages", () => {
    expect(custodyStageOfAudit("evidence_object.register")).toBe("REGISTERED");
    expect(custodyStageOfAudit("evidence_copy.worm_verified")).toBe("WORM_REPLICATED");
    expect(custodyStageOfAudit("evidence_legal_hold.apply")).toBe("LEGAL_HOLD_APPLIED");
    expect(custodyStageOfAudit("evidence_export.create")).toBe("EXPORTED");
  });

  it("maps read/access-shaped actions to ACCESSED", () => {
    expect(custodyStageOfAudit("evidence_object.read")).toBe("ACCESSED");
    expect(custodyStageOfAudit("copy.download")).toBe("ACCESSED");
  });

  it("returns null for unknown actions (timeline shows the raw action)", () => {
    expect(custodyStageOfAudit("workflow.execute")).toBeNull();
  });
});

describe("hold / copy helpers", () => {
  const activeHold: EvidenceLegalHold = {
    id: "h1",
    caseRef: "case-1",
    status: "ACTIVE",
    appliedAt: "2026-07-01T00:00:00Z",
  };

  it("holdActive is true only for an ACTIVE hold", () => {
    expect(holdActive([activeHold])).toBe(true);
    expect(holdActive([{ ...activeHold, status: "RELEASED" }])).toBe(false);
    expect(holdActive([])).toBe(false);
  });

  it("splits original and derivative copies", () => {
    const [withDerivatives] = evidenceFixtures();
    expect(originalOf(withDerivatives.copies)?.kind).toBe("ORIGINAL");
    expect(derivativesOf(withDerivatives.copies).every((c) => c.kind === "DERIVATIVE")).toBe(true);
  });

  it("shortDigest keeps 12 hex chars", () => {
    expect(shortDigest("abcdef0123456789deadbeef")).toBe("abcdef012345…");
  });

  it("formatSize renders B/KB/MB", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(2048)).toBe("2.0KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0MB");
  });
});

describe("admissibilityTone", () => {
  it("uses ok/warn/purple/danger tones", () => {
    expect(admissibilityTone("ADMISSIBLE")).toBe("ok");
    expect(admissibilityTone("REVIEW_NEEDED")).toBe("warn");
    expect(admissibilityTone("BLOCKED")).toBe("purple");
    expect(admissibilityTone("INADMISSIBLE")).toBe("danger");
  });
});

describe("toObjectCardDescriptor", () => {
  const [held, plain] = evidenceFixtures();

  it("locks the lifecycle while a legal hold is active", () => {
    const descriptor = toObjectCardDescriptor(held, held.holds, held.custody);
    expect(descriptor.lifecycleState).toBe("locked");
    expect(descriptor.code).toBe(held.code);
  });

  it("is active without a hold and carries the source relation", () => {
    const descriptor = toObjectCardDescriptor(plain, plain.holds, plain.custody);
    expect(descriptor.lifecycleState).toBe("active");
    expect(descriptor.relations[0]?.code).toBe(plain.source?.code);
  });

  it("marks disposed evidence as disposed", () => {
    const descriptor = toObjectCardDescriptor({ ...plain, disposed: true }, [], plain.custody);
    expect(descriptor.lifecycleState).toBe("disposed");
  });

  it("maps custody events into hash-flagged history", () => {
    const descriptor = toObjectCardDescriptor(held, held.holds, held.custody);
    expect(descriptor.history).toHaveLength(held.custody.length);
    expect(descriptor.history[0]?.hashVerified).toBe(held.fixity === "VERIFIED");
  });
});
