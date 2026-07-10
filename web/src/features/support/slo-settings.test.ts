import { describe, expect, it } from "vitest";

import {
  approveSloRevision,
  defaultSloSettings,
  sloDeadlineMs,
  sloPosture,
  sloWindowBreaches,
  stageSloEdit,
  withdrawSloRevision,
  type SloRules,
} from "./slo-settings";

const NOW = Date.parse("2026-06-13T12:00:00Z");
const RULES: SloRules = {
  ...defaultSloSettings().active,
  COMPLAINT: { thresholdHours: 4, windowDays: 7, escalationTarget: "ADMIN" },
};

function ticket(
  overrides: Partial<{
    category: keyof SloRules;
    status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "RESOLVED" | "CLOSED";
    created_at: string;
    due_at: string | null;
    resolved_at: string | null;
  }> = {},
) {
  return {
    category: "COMPLAINT" as const,
    status: "OPEN" as const,
    created_at: "2026-06-13T10:00:00Z",
    due_at: null,
    resolved_at: null,
    ...overrides,
  };
}

describe("slo posture (derived from the ACTIVE setting)", () => {
  it("derives the deadline from created_at + the type threshold", () => {
    // COMPLAINT threshold 4h → created 10:00 + 4h = 14:00, within the 4h soon window at 12:00.
    expect(sloPosture(ticket(), RULES, NOW)).toBe("dueSoon");
    expect(sloDeadlineMs(ticket(), RULES)).toBe(
      Date.parse("2026-06-13T14:00:00Z"),
    );
  });

  it("recomputes when the active rule changes (state-derived, §4-25-⑥)", () => {
    const tightened: SloRules = {
      ...RULES,
      COMPLAINT: { ...RULES.COMPLAINT, thresholdHours: 1 },
    };
    expect(sloPosture(ticket(), tightened, NOW)).toBe("overdue");
  });

  it("lets an explicit per-ticket due_at override the type default", () => {
    expect(
      sloPosture(ticket({ due_at: "2026-06-13T11:00:00Z" }), RULES, NOW),
    ).toBe("overdue");
    expect(
      sloPosture(ticket({ due_at: "2026-06-14T12:00:00Z" }), RULES, NOW),
    ).toBe("ok");
  });

  it("never flags terminal tickets and degrades to none on bad dates", () => {
    expect(
      sloPosture(
        ticket({ status: "RESOLVED", due_at: "2026-06-13T11:00:00Z" }),
        RULES,
        NOW,
      ),
    ).toBe("ok");
    expect(
      sloPosture(
        ticket({ status: "CLOSED", due_at: "2026-06-13T11:00:00Z" }),
        RULES,
        NOW,
      ),
    ).toBe("ok");
    expect(sloPosture(ticket({ created_at: "not-a-date" }), RULES, NOW)).toBe(
      "none",
    );
  });
});

describe("slo window breach tally", () => {
  it("counts open-past-deadline and late-resolved tickets inside the window only", () => {
    const counts = sloWindowBreaches(
      [
        // Open and past 4h target → breach.
        ticket({ created_at: "2026-06-13T06:00:00Z" }),
        // Resolved after the deadline → breach even though terminal.
        ticket({
          status: "RESOLVED",
          created_at: "2026-06-12T06:00:00Z",
          resolved_at: "2026-06-12T20:00:00Z",
        }),
        // Resolved inside the target → met.
        ticket({
          status: "RESOLVED",
          created_at: "2026-06-12T06:00:00Z",
          resolved_at: "2026-06-12T07:00:00Z",
        }),
        // Breached but created before the 7-day window → excluded.
        ticket({ created_at: "2026-06-01T06:00:00Z" }),
      ],
      RULES,
      NOW,
    );
    expect(counts.COMPLAINT).toBe(2);
    expect(counts.SYSTEM_BUG).toBe(0);
  });
});

describe("slo setting revision staging (§3.9.0)", () => {
  const editor = { id: "u-editor", name: "편집자" };
  const edited: SloRules = {
    ...RULES,
    OTHER: { thresholdHours: 12, windowDays: 14, escalationTarget: "ADMIN" },
  };

  it("stages an edit as pendingRev v+1 while the active rules keep serving", () => {
    const staged = stageSloEdit(defaultSloSettings(), edited, editor);
    expect(staged.version).toBe(1);
    expect(staged.active.OTHER.thresholdHours).toBe(48);
    expect(staged.pending).toMatchObject({
      version: 2,
      stagedById: "u-editor",
      stagedByName: "편집자",
    });
    expect(staged.pending?.rules.OTHER.thresholdHours).toBe(12);
  });

  it("promotes on approval by a different actor (four-eyes)", () => {
    const staged = stageSloEdit(defaultSloSettings(), edited, editor);
    const approved = approveSloRevision(staged, "u-approver");
    expect(approved.version).toBe(2);
    expect(approved.active.OTHER.thresholdHours).toBe(12);
    expect(approved.pending).toBeUndefined();
  });

  it("refuses self-approval by the stager", () => {
    const staged = stageSloEdit(defaultSloSettings(), edited, editor);
    const unchanged = approveSloRevision(staged, editor.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.active.OTHER.thresholdHours).toBe(48);
    expect(unchanged.pending).toBeDefined();
  });

  it("withdraws the staged revision leaving the active setting as-is", () => {
    const staged = stageSloEdit(defaultSloSettings(), edited, editor);
    const withdrawn = withdrawSloRevision(staged);
    expect(withdrawn.version).toBe(1);
    expect(withdrawn.active.OTHER.thresholdHours).toBe(48);
    expect(withdrawn.pending).toBeUndefined();
  });
});
