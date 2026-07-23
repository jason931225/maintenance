import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue } from "../../context/auth";
import { ComplianceModuleScreenBody } from "./ComplianceModuleScreenBody";

function renderBody(roles: string[], featureGrants: string[] = []) {
  const api = {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/compliance/obligations") return Promise.resolve({ data: { items: [{ id: "cp-1", code: "CP-0001", title: "근로시간 준수", description: "설명", obligation_type: "LEGAL", scope: { kind: "ORG", scope_ref: null, branch_id: null, site_id: null }, owner_user_id: null, severity: "HIGH", status: "ACTIVE", effective_from: null, effective_to: null, review_cadence: null, next_review_on: null, metadata: {}, created_by: "user", updated_by: "user", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }], limit: 100, offset: 0, total: 1 } });
      if (path === "/api/v1/compliance/regulations") return Promise.resolve({ data: { items: [{ id: "rg-1", code: "RG-0001", title: "근로기준법", jurisdiction: "대한민국", citation: "제50조", impact_area: "인사", impact_summary: "규정", risk_level: "HIGH", status: "ACTIVE", owner_user_id: null, effective_from: null, effective_to: null, review_due_on: null, metadata: {}, created_by: "user", updated_by: "user", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }], limit: 100, offset: 0, total: 1 } });
      return Promise.resolve({ data: { items: [], limit: 100, offset: 0, total: 0 } });
    }),
  } as unknown as ConsoleApiClient;
  const authValue = {
    session: { access_token: "cp-token", roles, feature_grants: featureGrants },
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api,
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  } as unknown as AuthContextValue;
  return render(
    <AuthContext.Provider value={authValue}>
      <ComplianceModuleScreenBody />
    </AuthContext.Provider>,
  );
}

describe("ComplianceModuleScreenBody", () => {
  it("renders the CP-/RG-/FW- catalog for an integrity-role reader", async () => {
    renderBody(["EXECUTIVE"]);
    // CP-0001 is the auto-selected first row, so it renders in both the list
    // cell and the detail pane.
    expect((await screen.findAllByText("CP-0001")).length).toBeGreaterThan(0);
    // Regulation + framework kinds share the same catalog surface.
    expect(screen.getByText("RG-0001")).toBeInTheDocument();
  });

  it("renders the catalog for a holder of the integrity-findings feature grant", async () => {
    renderBody(["MECHANIC"], ["integrity_findings_read"]);
    expect((await screen.findAllByText("CP-0001")).length).toBeGreaterThan(0);
  });

  it("denies the whole surface by omission for an unauthorized role", async () => {
    renderBody(["MEMBER"]);
    // GenericModuleScreen gates its entire content plane on the read action;
    // an unauthorized session never sees a catalog row (no disabled ghost).
    await waitFor(() => {
      expect(screen.queryByText("CP-0001")).not.toBeInTheDocument();
    });
  });
});
