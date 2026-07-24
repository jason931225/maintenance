import { beforeEach, describe, expect, it } from "vitest";

import { clearQuoteDraft, loadQuoteDraft, newIdempotencyKey, saveQuoteDraft } from "./quoteDraft";

const scope = { orgId: "org-1", actorId: "actor-1", sessionKey: "session-1" };
const otherActorScope = { ...scope, actorId: "actor-2" };

describe("quoteDraft", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a draft, keyed per branch and unit", () => {
    const draft = {
      idempotencyKey: newIdempotencyKey(),
      customerName: "customer",
      siteReference: "site",
      monthlyRate: "2500000",
      durationMonths: "12",
    };
    saveQuoteDraft(scope, "branch-1", "unit-1", draft);
    expect(loadQuoteDraft(scope, "branch-1", "unit-1")).toEqual(draft);
    expect(loadQuoteDraft(scope, "branch-1", "unit-2")).toBeUndefined();
    expect(loadQuoteDraft(scope, "branch-2", "unit-1")).toBeUndefined();
    expect(loadQuoteDraft(otherActorScope, "branch-1", "unit-1")).toBeUndefined();
  });

  it("keeps the idempotency key stable across reloads", () => {
    const draft = {
      idempotencyKey: newIdempotencyKey(),
      customerName: "",
      siteReference: "",
      monthlyRate: "",
      durationMonths: "",
    };
    saveQuoteDraft(scope, "branch-1", "unit-1", draft);
    const first = loadQuoteDraft(scope, "branch-1", "unit-1");
    const second = loadQuoteDraft(scope, "branch-1", "unit-1");
    expect(first?.idempotencyKey).toBe(draft.idempotencyKey);
    expect(second?.idempotencyKey).toBe(draft.idempotencyKey);
  });

  it("generates keys inside the contract's 16..200 length window", () => {
    const key = newIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(newIdempotencyKey()).not.toBe(key);
  });

  it("rejects corrupt or short-key payloads instead of resurrecting them", () => {
    window.localStorage.setItem("equipment3r.quote-draft.branch-1.unit-1", "{not json");
    expect(loadQuoteDraft(scope, "branch-1", "unit-1")).toBeUndefined();
    window.localStorage.setItem(
      "equipment3r.quote-draft.branch-1.unit-1",
      JSON.stringify({ idempotencyKey: "short", customerName: "x" }),
    );
    expect(loadQuoteDraft(scope, "branch-1", "unit-1")).toBeUndefined();
  });

  it("clears a stored draft", () => {
    saveQuoteDraft(scope, "branch-1", "unit-1", {
      idempotencyKey: newIdempotencyKey(),
      customerName: "",
      siteReference: "",
      monthlyRate: "",
      durationMonths: "",
    });
    clearQuoteDraft(scope, "branch-1", "unit-1");
    expect(loadQuoteDraft(scope, "branch-1", "unit-1")).toBeUndefined();
  });
});
