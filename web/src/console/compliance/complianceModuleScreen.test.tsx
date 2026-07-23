import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { GenericModuleScreen } from "../modules/GenericModuleScreen";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { complianceModuleScreen } from "./complianceModuleScreen";

const allowGate: PolicyGate = { can: () => true };
const denyGate: PolicyGate = { can: () => false };

const obligation = {
  id: "obligation-1", code: "CP-0001", title: "근로시간 준수", description: "근로시간을 검토합니다.",
  obligation_type: "LEGAL", scope: { kind: "ORG", scope_ref: null, branch_id: null, site_id: null },
  owner_user_id: "owner-1", severity: "HIGH", status: "ACTIVE", effective_from: "2026-01-01",
  effective_to: null, review_cadence: "ANNUAL", next_review_on: "2027-01-01", metadata: { source: "law" },
  created_by: "creator-1", updated_by: "updater-1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
};
const regulation = {
  id: "regulation-1", code: "RG-0001", title: "근로기준법", jurisdiction: "대한민국", regulator: "고용노동부",
  citation: "제50조", source_url: "https://example.test/law", impact_area: "인사", impact_summary: "근로시간 규정",
  risk_level: "HIGH", status: "ACTIVE", effective_from: "2026-01-01", effective_to: null, review_due_on: "2027-01-01",
  owner_user_id: "owner-1", metadata: { provenance: "official" }, created_by: "creator-1", updated_by: "updater-1",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-02T00:00:00Z",
};
const framework = {
  id: "framework-1", code: "FW-0001", name: "ISMS", version_label: "2025", framework_kind: "SECURITY_STANDARD",
  status: "ACTIVE", owner_user_id: "owner-1", effective_from: "2026-01-01", effective_to: null,
  metadata: { provenance: "certification" }, created_by: "creator-1", updated_by: "updater-1",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T00:00:00Z",
};
const control = {
  id: "control-1", framework_id: "framework-1", control_key: "ISMS-1", title: "접근 통제", objective: "접근을 검토합니다.",
  control_type: "PREVENTIVE", cadence: "ANNUAL", status: "ACTIVE", evidence_requirements: { required: true }, owner_user_id: "owner-1",
  created_by: "creator-1", updated_by: "updater-1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T00:00:00Z",
};
const evidence = {
  id: "evidence-1", control_id: "control-1", obligation_id: "obligation-1", evidence_target_type: "DOCUMENT",
  evidence_target_id: "document-1", source_audit_event_id: null, status: "ACCEPTED", confidence: "HIGH", collected_at: "2026-02-03T00:00:00Z",
  collected_by: "owner-1", valid_from: "2026-01-01", valid_to: null, hash_sha256: "hash", metadata: { provenance: "vault" },
  created_by: "creator-1", updated_by: "updater-1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T00:00:00Z",
};

function page(items: unknown[]) { return { items, limit: 100, offset: 0, total: items.length }; }

function apiWithCatalog() {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/compliance/obligations") return { data: page([obligation]) };
    if (path === "/api/v1/compliance/regulations") return { data: page([regulation]) };
    if (path === "/api/v1/compliance/frameworks") return { data: page([framework]) };
    if (path === "/api/v1/compliance/framework-controls") return { data: page([control]) };
    if (path === "/api/v1/compliance/evidence-bindings") return { data: page([evidence]) };
    throw new Error(`unexpected path ${path}`);
  });
  return { api: { GET } as unknown as ConsoleApiClient, GET };
}

function renderCompliance(api: ConsoleApiClient, gate: PolicyGate = allowGate) {
  return render(
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={complianceModuleScreen} api={api} />
    </PolicyGateProvider>,
  );
}

describe("complianceModuleScreen", () => {
  it("reads the authorized CP-/RG-/FW- catalog from REST rather than local fixtures", async () => {
    const { api, GET } = apiWithCatalog();
    renderCompliance(api);

    await waitFor(() => expect(screen.getByRole("button", { name: "CP-0001 상세 열기" })).toBeVisible());
    expect(screen.getByRole("button", { name: "RG-0001 상세 열기" })).toBeVisible();
    expect(screen.getByRole("button", { name: "FW-0001 상세 열기" })).toBeVisible();
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/obligations", expect.anything());
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/regulations", expect.anything());
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/frameworks", expect.anything());
  });

  it("loads a selected framework's real controls and evidence bindings into the detail matrix", async () => {
    const { api, GET } = apiWithCatalog();
    const user = (await import("@testing-library/user-event")).default.setup();
    renderCompliance(api);

    await user.click(await screen.findByRole("button", { name: "FW-0001 상세 열기" }));
    await waitFor(() => expect(screen.getByText(/ISMS-1/)).toBeVisible());
    expect(screen.getByText(/1\/1/)).toBeVisible();
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/framework-controls", expect.anything());
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/evidence-bindings", expect.anything());
  });

  it("keeps the real server status and never exposes the catalog before local policy allows it", async () => {
    const { api, GET } = apiWithCatalog();
    renderCompliance(api, denyGate);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(GET).not.toHaveBeenCalled();

    renderCompliance(api);
    await waitFor(() => expect(screen.getAllByText(ko.console.modules.compliance.statuses.active).length).toBeGreaterThan(0));
  });

  it("does not request catalog kinds that the local policy has denied", async () => {
    const { api, GET } = apiWithCatalog();
    renderCompliance(api, { can: (action) => action === complianceModuleScreen.policy.read });

    await screen.findByRole("button", { name: "CP-0001 상세 열기" });
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/obligations", expect.anything());
    expect(GET).not.toHaveBeenCalledWith("/api/v1/compliance/regulations", expect.anything());
    expect(GET).not.toHaveBeenCalledWith("/api/v1/compliance/frameworks", expect.anything());
  });
});

  it("walks every declared catalog page instead of hiding row 101", async () => {
    const obligations = Array.from({ length: 101 }, (_, index) => ({
      ...obligation,
      id: `obligation-${String(index + 1)}`,
      code: `CP-${String(index + 1).padStart(4, "0")}`,
      title: `의무 ${String(index + 1)}`,
    }));
    const GET = vi.fn(async (path: string, init: { params: { query: { offset?: number } } }) => {
      const offset = init.params.query.offset ?? 0;
      if (path === "/api/v1/compliance/obligations") return { data: { items: obligations.slice(offset, offset + 100), limit: 100, offset, total: obligations.length } };
      if (path === "/api/v1/compliance/regulations" || path === "/api/v1/compliance/frameworks") return { data: page([]) };
      throw new Error(`unexpected path ${path}`);
    });
    renderCompliance({ GET } as unknown as ConsoleApiClient, { can: (action) => action === complianceModuleScreen.policy.read });

    await screen.findByRole("button", { name: "CP-0101 상세 열기" });
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/obligations", expect.objectContaining({
      params: { query: expect.objectContaining({ offset: 100, limit: 100 }) },
    }));
  });

  it("walks every controls and evidence page for a selected framework", async () => {
    const controls = Array.from({ length: 101 }, (_, index) => ({
      ...control,
      id: `control-${String(index + 1)}`,
      control_key: `ISMS-${String(index + 1)}`,
    }));
    const bindings = Array.from({ length: 101 }, (_, index) => ({
      ...evidence,
      id: `evidence-${String(index + 1)}`,
      control_id: "control-1",
    }));
    const GET = vi.fn(async (path: string, init: { params: { query: { offset?: number; control_id?: string } } }) => {
      const offset = init.params.query.offset ?? 0;
      if (path === "/api/v1/compliance/obligations" || path === "/api/v1/compliance/regulations") return { data: page([]) };
      if (path === "/api/v1/compliance/frameworks") return { data: page([framework]) };
      if (path === "/api/v1/compliance/framework-controls") return { data: { items: controls.slice(offset, offset + 100), limit: 100, offset, total: controls.length } };
      if (path === "/api/v1/compliance/evidence-bindings") {
        const rows = init.params.query.control_id === "control-1" ? bindings : [];
        return { data: { items: rows.slice(offset, offset + 100), limit: 100, offset, total: rows.length } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    renderCompliance({ GET } as unknown as ConsoleApiClient, { can: (action) => action !== complianceModuleScreen.policy.read || true });

    await (await import("@testing-library/user-event")).default.setup().click(await screen.findByRole("button", { name: "FW-0001 상세 열기" }));
    await screen.findByText(/1\/101/);
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/framework-controls", expect.objectContaining({
      params: { query: expect.objectContaining({ offset: 100 }) },
    }));
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/evidence-bindings", expect.objectContaining({
      params: { query: expect.objectContaining({ control_id: "control-1", offset: 100 }) },
    }));
  });

  it("retains a scoped result and exposes an accessible retry when a refresh fails", async () => {
    let reads = 0;
    const GET = vi.fn(async (path: string) => {
      if (path === "/api/v1/compliance/obligations") {
        reads += 1;
        if (reads === 2) throw new Error("temporary failure");
        return { data: page([obligation]) };
      }
      if (path === "/api/v1/compliance/regulations" || path === "/api/v1/compliance/frameworks") return { data: page([]) };
      throw new Error(`unexpected path ${path}`);
    });
    renderCompliance({ GET } as unknown as ConsoleApiClient, { can: (action) => action === complianceModuleScreen.policy.read });
    await screen.findByRole("button", { name: "CP-0001 상세 열기" });
    // A query update triggers a new authenticated read without erasing the old table.
    const input = screen.getByRole("searchbox");
    const user = (await import("@testing-library/user-event")).default.setup();
    await user.type(input, "x");
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "CP-0001 상세 열기" })).toBeVisible();
    const retry = screen.getByRole("button", { name: ko.page.retry });
    expect(retry).toBeVisible();
    await user.click(retry);
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
