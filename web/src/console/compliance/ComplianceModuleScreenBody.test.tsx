import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue } from "../../context/auth";
import { ComplianceModuleScreenBody } from "./ComplianceModuleScreenBody";

function renderBody(roles: string[], featureGrants: string[] = []) {
  const authValue = {
    session: { access_token: "cp-token", roles, feature_grants: featureGrants },
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api: createConsoleApiClient("cp-token"),
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
