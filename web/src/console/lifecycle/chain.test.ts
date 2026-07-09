import { describe, expect, it } from "vitest";

import {
  DOCUMENT_CHAIN,
  allowedTransitions,
  chainFor,
  computeStepper,
  disposeBlock,
} from "./chain";
import type { Lifecycle } from "./types";

function record(patch: Partial<Lifecycle>): Lifecycle {
  return {
    objectType: "document",
    objectId: "00000000-0000-0000-0000-0000000cae05",
    currentState: "draft",
    legalHold: false,
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T09:00:00Z",
    transitions: [],
    ...patch,
  };
}

describe("computeStepper", () => {
  it("marks steps before the current stage done, the containing stage current, the rest pending", () => {
    // `approved` lives in the "review" stage (index 1).
    const steps = computeStepper(DOCUMENT_CHAIN, "approved");
    expect(steps.map((s) => [s.key, s.status])).toEqual([
      ["draft", "done"],
      ["review", "current"],
      ["active", "pending"],
      ["archived", "pending"],
      ["disposed", "pending"],
    ]);
  });

  it("folds submitted and approved onto the same review stage", () => {
    expect(computeStepper(DOCUMENT_CHAIN, "submitted")[1].status).toBe("current");
    expect(computeStepper(DOCUMENT_CHAIN, "approved")[1].status).toBe("current");
  });

  it("folds active and revised onto the active stage", () => {
    expect(computeStepper(DOCUMENT_CHAIN, "revised")[2].status).toBe("current");
  });

  it("puts the terminal state at the last stage with everything before it done", () => {
    const steps = computeStepper(DOCUMENT_CHAIN, "disposed");
    expect(steps.every((s, i) => (i < 4 ? s.status === "done" : s.status === "current"))).toBe(true);
  });

  it("renders all-pending for an unknown state (deny-by-omission, no guess)", () => {
    expect(computeStepper(DOCUMENT_CHAIN, "bogus").every((s) => s.status === "pending")).toBe(true);
  });
});

describe("allowedTransitions", () => {
  it("returns the single forward edge for each state (linear document FSM)", () => {
    expect(allowedTransitions(DOCUMENT_CHAIN, "draft")).toEqual(["submitted"]);
    expect(allowedTransitions(DOCUMENT_CHAIN, "archived")).toEqual(["disposed"]);
  });
  it("returns nothing from the terminal state (no rollback edge — BE-LC gap)", () => {
    expect(allowedTransitions(DOCUMENT_CHAIN, "disposed")).toEqual([]);
  });
});

describe("disposeBlock (mirrors the server fail-closed gate)", () => {
  it("blocks on an active legal hold", () => {
    expect(disposeBlock(record({ legalHold: true }), "2026-06-06")).toBe("legalHold");
  });
  it("blocks while retention is still in the future", () => {
    expect(disposeBlock(record({ retentionUntil: "2030-01-01" }), "2026-06-06")).toBe("retention");
  });
  it("does not block once retention has passed and no hold is set", () => {
    expect(disposeBlock(record({ retentionUntil: "2020-01-01" }), "2026-06-06")).toBeNull();
  });
  it("prefers the legal-hold reason when both apply", () => {
    expect(disposeBlock(record({ legalHold: true, retentionUntil: "2030-01-01" }), "2026-06-06")).toBe("legalHold");
  });
});

describe("chainFor", () => {
  it("resolves the document chain and nothing for types without a live FSM", () => {
    expect(chainFor("document")).toBe(DOCUMENT_CHAIN);
    expect(chainFor("contract")).toBeUndefined();
  });
});
