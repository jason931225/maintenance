import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { EvidenceBindingWorkbench } from "./EvidenceBindingWorkbench";

const framework = {
  id: "11111111-1111-4111-8111-111111111111", code: "FW-0001", name: "ISMS", version_label: "2026",
  framework_kind: "SECURITY_STANDARD", status: "ACTIVE", owner_user_id: null, effective_from: null, effective_to: null,
  metadata: {}, created_by: "actor", updated_by: "actor", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const control = {
  id: "22222222-2222-4222-8222-222222222222", framework_id: framework.id, control_key: "ISMS-5", title: "권한 검토", objective: "권한 부여를 검토합니다.",
  control_type: "PREVENTIVE", cadence: "ANNUAL", status: "ACTIVE", evidence_requirements: {}, owner_user_id: null,
  created_by: "actor", updated_by: "actor", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const obligation = {
  id: "44444444-4444-4444-8444-444444444444", code: "CP-0017", title: "접근 권한 검토", description: "권한 검토",
  obligation_type: "LEGAL", scope: { kind: "ORG", scope_ref: null, branch_id: null, site_id: null }, owner_user_id: null, severity: "HIGH", status: "ACTIVE",
  effective_from: null, effective_to: null, review_cadence: null, next_review_on: null, metadata: {}, created_by: "actor", updated_by: "actor", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const evidence = {
  id: "33333333-3333-4333-8333-333333333333", control_id: control.id, obligation_id: "44444444-4444-4444-8444-444444444444",
  evidence_target_type: "external_document" as const, evidence_target_id: "POL-2026-17", source_audit_event_id: "55555555-5555-4555-8555-555555555555",
  status: "ACCEPTED" as const, confidence: "HIGH" as const, collected_at: "2026-07-20T08:00:00Z", collected_by: "actor",
  valid_from: "2026-01-01", valid_to: "2026-12-31", hash_sha256: "abc", metadata: { source: "records" },
  created_by: "actor", updated_by: "actor", created_at: "2026-07-20T08:00:00Z", updated_at: "2026-07-20T08:00:00Z",
};

function page(items: unknown[]) { return { items, limit: 100, offset: 0, total: items.length }; }

function renderWorkbench(options: { canWrite?: boolean; getImpl?: (path: string, init: unknown) => Promise<unknown> } = {}) {
  const api = createConsoleApiClient("compliance-test-token");
  const GET = vi.spyOn(api, "GET").mockImplementation(options.getImpl ?? ((path: string) => {
    if (path === "/api/v1/compliance/frameworks") return Promise.resolve({ data: page([framework]) });
    if (path === "/api/v1/compliance/obligations") return Promise.resolve({ data: page([obligation]) });
    if (path === "/api/v1/compliance/framework-controls") return Promise.resolve({ data: page([control]) });
    if (path === "/api/v1/compliance/evidence-bindings") return Promise.resolve({ data: page([evidence]) });
    return Promise.reject(new Error(`unexpected ${path}`));
  }));
  const POST = vi.spyOn(api, "POST").mockResolvedValue({ data: evidence });
  return { GET, POST, ...render(<EvidenceBindingWorkbench api={api} authorityKey="tenant-a:user-a:incarnation-a" canWrite={options.canWrite ?? true} />) };
}

describe("EvidenceBindingWorkbench", () => {
  afterEach(cleanup);

  it("renders server-authorized control-to-evidence history and a selected binding's immutable provenance", async () => {
    const { GET } = renderWorkbench();
    const region = await screen.findByRole("region", { name: "Evidence bindings" });
    expect(within(region).getByText("ISMS-5 · 권한 검토 · CP-0017")).toBeVisible();
    expect(within(region).getByText("POL-2026-17")).toBeVisible();
    await userEvent.setup().click(within(region).getByRole("button", { name: /POL-2026-17 details/ }));
    const detail = within(region).getByRole("complementary", { name: "Selected evidence details" });
    expect(within(detail).getByText("external_document")).toBeVisible();
    expect(within(detail).getByText("2026-12-31")).toBeVisible();
    expect(within(detail).getByText("55555555-5555-4555-8555-555555555555")).toBeVisible();
    expect(within(detail).getAllByText("actor")).toHaveLength(3);
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/frameworks", expect.anything());
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/obligations", expect.anything());
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/framework-controls", expect.objectContaining({ params: { query: expect.objectContaining({ framework_id: framework.id }) } }));
    expect(GET).toHaveBeenCalledWith("/api/v1/compliance/evidence-bindings", expect.objectContaining({ params: { query: { limit: 100, offset: 0 } } }));
  });

  it("submits only an authorized proposal using the generated REST operation, then refreshes server truth", async () => {
    const { POST, GET } = renderWorkbench();
    await screen.findByRole("region", { name: "Evidence bindings" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Control"), control.id);
    await user.selectOptions(screen.getByLabelText("Obligation (optional)"), obligation.id);
    await user.selectOptions(screen.getByLabelText("Evidence type"), "external_document");
    await user.type(screen.getByLabelText("Evidence ID"), "  POL-2026-18  ");
    await user.selectOptions(screen.getByLabelText("Confidence"), "HIGH");
    await user.type(screen.getByLabelText("Valid from"), "2026-08-01");
    await user.type(screen.getByLabelText("Valid to"), "2026-12-31");
    await user.click(screen.getByRole("button", { name: "Propose binding" }));
    await waitFor(() => { expect(POST).toHaveBeenCalledWith("/api/v1/compliance/evidence-bindings", {
      body: {
        control_id: control.id,
        obligation_id: obligation.id,
        evidence_target_type: "external_document",
        evidence_target_id: "POL-2026-18",
        confidence: "HIGH",
        valid_from: "2026-08-01",
        valid_to: "2026-12-31",
      },
      signal: expect.any(AbortSignal),
    }); });
    await waitFor(() => { expect(GET).toHaveBeenCalledTimes(8); });
  });

  it("does not fabricate an accepted row after a conflict and exposes retry with existing server history intact", async () => {
    const { POST } = renderWorkbench();
    await screen.findByRole("region", { name: "Evidence bindings" });
    POST.mockRejectedValueOnce(new ApiCallError(409));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Control"), control.id);
    await user.type(screen.getByLabelText("Evidence ID"), "POL-2026-18");
    await user.click(screen.getByRole("button", { name: "Propose binding" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This conflicts with another change. Refresh server state and retry.");
    expect(screen.getByText("POL-2026-17")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("renders a generated 403 read result as an authorization denial", async () => {
    const error = { error: { code: "forbidden", message: "evidence read is not authorized" } };
    const { GET } = renderWorkbench({ getImpl: () => Promise.resolve({
      error,
      response: new Response(JSON.stringify(error), { status: 403 }),
    }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("You are not authorized to view evidence bindings.");
    expect(GET).toHaveBeenCalled();
  });

  it("does not render or request the workbench for a caller without the parent read authority", () => {
    const api = createConsoleApiClient("compliance-test-token");
    const GET = vi.spyOn(api, "GET");
    render(<EvidenceBindingWorkbench api={api} authorityKey="tenant-a:user-a:incarnation-a" canRead={false} canWrite={false} />);
    expect(screen.queryByRole("region", { name: "Evidence bindings" })).not.toBeInTheDocument();
    expect(GET).not.toHaveBeenCalled();
  });

  it("aborts a submitted proposal and synchronously clears write state on an authority switch", async () => {
    const api = createConsoleApiClient("compliance-test-token");
    vi.spyOn(api, "GET").mockImplementation((path: string) => {
      if (path === "/api/v1/compliance/frameworks") return Promise.resolve({ data: page([framework]) });
      if (path === "/api/v1/compliance/obligations") return Promise.resolve({ data: page([obligation]) });
      if (path === "/api/v1/compliance/framework-controls") return Promise.resolve({ data: page([control]) });
      if (path === "/api/v1/compliance/evidence-bindings") return Promise.resolve({ data: page([evidence]) });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    let writeSignal: AbortSignal | undefined;
    const POST = vi.spyOn(api, "POST").mockImplementation((_path: string, init: { signal?: AbortSignal }) => new Promise((_, reject) => {
      writeSignal = init.signal;
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }) as never);
    const view = render(<EvidenceBindingWorkbench key="tenant-a:user-a:incarnation-a" api={api} authorityKey="tenant-a:user-a:incarnation-a" canWrite />);
    await screen.findByRole("region", { name: "Evidence bindings" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Control"), control.id);
    await user.type(screen.getByLabelText("Evidence ID"), "POL-2026-18");
    await user.click(screen.getByRole("button", { name: "Propose binding" }));
    expect(await screen.findByRole("button", { name: "Linking…" })).toBeDisabled();
    view.rerender(<EvidenceBindingWorkbench key="tenant-b:user-b:incarnation-b" api={api} authorityKey="tenant-b:user-b:incarnation-b" canWrite />);
    expect(writeSignal?.aborted).toBe(true);
    expect(await screen.findByRole("button", { name: "Propose binding" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Linking…" })).not.toBeInTheDocument();
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it("aborts a prior scoped read when authority changes", async () => {
    const api = createConsoleApiClient("compliance-test-token");
    const GET = vi.spyOn(api, "GET").mockImplementation((_path: string, init: { signal?: AbortSignal }) => new Promise(() => {
      // The assertion observes the exact signal passed to the generated client.
      void init.signal;
    }) as never);
    const view = render(<EvidenceBindingWorkbench api={api} authorityKey="tenant-a:user-a:incarnation-a" canWrite />);
    await waitFor(() => { expect(GET).toHaveBeenCalledTimes(3); });
    const first = GET.mock.calls[0]?.[1] as { signal?: AbortSignal };
    view.rerender(<EvidenceBindingWorkbench api={api} authorityKey="tenant-b:user-b:incarnation-b" canWrite />);
    expect(first.signal?.aborted).toBe(true);
    view.unmount();
  });
});
