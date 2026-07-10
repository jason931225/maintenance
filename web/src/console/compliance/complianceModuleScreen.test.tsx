import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { GenericModuleScreen } from "../modules/GenericModuleScreen";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { complianceModuleScreen } from "./complianceModuleScreen";

const allowGate: PolicyGate = { can: () => true };
const denyGate: PolicyGate = { can: () => false };
const stubApi = {} as ConsoleApiClient;

function renderCompliance(gate: PolicyGate = allowGate) {
  return render(
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={complianceModuleScreen} api={stubApi} />
    </PolicyGateProvider>,
  );
}

describe("complianceModuleScreen", () => {
  it("lists every CP-/RG-/FW- catalog row via the shared module table", async () => {
    renderCompliance();

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeVisible();
    });
    for (const code of ["CP-0001", "CP-0002", "CP-0003", "RG-0001", "RG-0002", "FW-0001", "FW-0002"]) {
      expect(screen.getByRole("button", { name: `${code} 상세 열기` })).toBeVisible();
    }
  });

  it("opens a framework row into the right-pin detail with its control-evidence matrix", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    renderCompliance();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "FW-0001 상세 열기" })).toBeVisible();
    });
    await user.click(screen.getByRole("button", { name: "FW-0001 상세 열기" }));

    // Control keys are literal (not routed through ko.ts) so this assertion
    // is stable regardless of the koManifest merge timing.
    await waitFor(() => {
      expect(screen.getByText(/ISMS-2\.5\.1/)).toBeVisible();
    });
    expect(screen.getByText(/1\/3/)).toBeVisible();
  });

  it("shows the REAL obligation status (WAIVED), not a generic placeholder state", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    renderCompliance();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "CP-0002 상세 열기" })).toBeVisible();
    });
    await user.click(screen.getByRole("button", { name: "CP-0002 상세 열기" }));

    await waitFor(() => {
      expect(screen.getAllByText(ko.console.modules.compliance.statuses.waived).length).toBeGreaterThan(0);
    });
  });

  it("gates the whole surface on the read policy (fail-closed)", () => {
    renderCompliance(denyGate);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("gates the audit-trail link chip independently of table read access", async () => {
    const readOnlyGate: PolicyGate = { can: (action) => action === complianceModuleScreen.policy.read };
    renderCompliance(readOnlyGate);

    // The chip is present but its policy-gated label never renders when denied.
    await waitFor(() => {
      expect(screen.getByRole("table")).toBeVisible();
    });
    expect(screen.queryByText(ko.console.modules.compliance.links.audit)).not.toBeInTheDocument();

    const allowAllGate: PolicyGate = { can: () => true };
    renderCompliance(allowAllGate);
    expect((await screen.findAllByText(ko.console.modules.compliance.links.audit)).length).toBeGreaterThan(0);
  });
});
