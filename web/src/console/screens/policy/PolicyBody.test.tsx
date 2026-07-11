import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAuthorizeBulkCache } from "../../../api/authorizeBulk";
import { ko } from "../../../i18n/ko";
import { PolicyBody } from "./PolicyBody";

// ko.console.policycanvas is already fully wired (real Korean) — assert
// against it directly, same convention as LeaveBody.test.tsx / ko.console.leave.
// `list` is the body's own list-strip strings, now merged in alongside it.
const S = ko.console.policycanvas;
const W = S.wire;
const L = S.list;

const mockUseAuth = vi.fn();
vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));

const catalog = [
  {
    id: "cat-1",
    stable_key: "policy.wo_view",
    title: "Work order view",
    effect: "permit",
    status: "enforced",
    source: "promoted_policy",
    validation_status: "valid",
    updated_at: "2026-07-01T00:00:00Z",
  },
  {
    id: "cat-2",
    stable_key: "policy.dispatch_export",
    title: "Dispatch export block",
    effect: "forbid",
    status: "shadow",
    source: "seed",
    validation_status: "valid",
    updated_at: "2026-07-02T00:00:00Z",
  },
];

function draft(overrides: Record<string, unknown>) {
  return {
    id: "draft-x",
    draft_key: "policy.x",
    title: "Draft",
    normalized_row: { effect: "permit", action: "view", resource_type: "work_order", conditions: [] },
    generated_policy_text: "permit(principal, action, resource);",
    validation_status: "valid",
    validation_errors: [],
    review_status: "draft",
    reviewer_id: null,
    created_by: "u1",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    ...overrides,
  };
}

const drafts = [
  draft({ id: "draft-1", draft_key: "policy.wo_view", title: "Work order view" }),
  draft({ id: "draft-2", draft_key: "policy.standalone_new", title: "New standalone rule", review_status: "review_pending" }),
];

interface AuthOverrides {
  catalogReject?: boolean;
  catalogPending?: boolean;
  employeeTotal?: number;
}

function setupAuth(overrides: AuthOverrides = {}) {
  const { employeeTotal = 1284 } = overrides;
  const GET = vi.fn(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/policy/catalog") {
      if (overrides.catalogPending) return new Promise(() => {}) as never;
      if (overrides.catalogReject) throw new Error("boom");
      return { data: catalog };
    }
    if (path === "/api/v1/policy/drafts") return { data: drafts };
    if (path === "/api/v1/employees") return { data: { items: [], total: employeeTotal, limit: 1, offset: 0 } };
    throw new Error(`unexpected GET ${path}`);
  });
  const POST = vi.fn(async (path: string, opts: unknown) => {
    await Promise.resolve();
    if (path === "/api/v1/policy/authorize/bulk") {
      const checks = (opts as { body: { checks: { action: string }[] } }).body.checks;
      return { data: { decisions: checks.map(() => ({ effect: "allow" })) } };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  mockUseAuth.mockReturnValue({
    api: { GET, POST },
    session: { user_id: "self-user", org_id: "org-1", roles: ["SUPER_ADMIN"] },
  });
  return { GET, POST };
}

function renderBody() {
  render(<PolicyBody />);
}

afterEach(() => {
  mockUseAuth.mockReset();
  clearAuthorizeBulkCache();
});

describe("PolicyBody", () => {
  it("shows the loading state before the catalog resolves", () => {
    setupAuth({ catalogPending: true });
    renderBody();
    expect(screen.getByText(W.loading)).toBeVisible();
  });

  it("wires the real catalog + drafts into a flat list with 허용/금지 + 시행중/초안 chips", async () => {
    setupAuth();
    renderBody();

    expect(await screen.findByText("Work order view")).toBeVisible();
    expect(screen.getByText("Dispatch export block")).toBeVisible();
    // Standalone draft (not promoted to catalog) also lists.
    expect(screen.getByText("New standalone rule")).toBeVisible();

    expect(screen.getAllByText(S.effectLabels.permit).length).toBeGreaterThan(0);
    expect(screen.getByText(S.effectLabels.forbid)).toBeVisible();
    expect(screen.getByText(W.catalogStatus.enforced)).toBeVisible();
  });

  it("every stat drills the list (§4-11): 활성정책/초안 filter, 적용대상 resets", async () => {
    setupAuth();
    renderBody();
    await screen.findByText("Work order view");

    await userEvent.click(screen.getByRole("button", { name: L.drill(L.activeStat) }));
    expect(screen.getByText("Work order view")).toBeVisible();
    expect(screen.queryByText("Dispatch export block")).toBeNull();
    expect(screen.queryByText("New standalone rule")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: L.drill(L.draftStat) }));
    expect(screen.queryByText("Work order view")).toBeNull();
    expect(screen.getByText("Dispatch export block")).toBeVisible();
    expect(screen.getByText("New standalone rule")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: L.drill(L.targetStat) }));
    expect(screen.getByText("Work order view")).toBeVisible();
    expect(screen.getByText("Dispatch export block")).toBeVisible();
  });

  it("policy/draft counts use a count unit, not a headcount unit (verdict R3 KPI unit bug)", async () => {
    setupAuth();
    renderBody();
    await screen.findByText("Work order view");

    // 1 active (enforced) policy in the fixture, 1 draft (shadow) — the
    // stat value must not read like a headcount ("1명") for a policy count.
    const activeStat = screen.getByRole("button", { name: L.drill(L.activeStat) });
    expect(activeStat).not.toHaveTextContent("1명");
    const draftStat = screen.getByRole("button", { name: L.drill(L.draftStat) });
    expect(draftStat).not.toHaveTextContent("1명");
  });

  it("screen title reads 권한·정책 grammar (policycanvas title is renamed on this list screen only)", async () => {
    setupAuth();
    renderBody();
    await screen.findByText("Work order view");
    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
    // The internal policycanvas studio title ("정책 캔버스") is untouched —
    // only this list screen's own header changes (koManifest: screenTitle).
    expect(screen.queryByText(S.title)).toBeNull();
  });

  it("real, non-fabricated org headcount drives the 적용대상 stat", async () => {
    setupAuth({ employeeTotal: 42 });
    renderBody();
    await screen.findByText("Work order view");
    expect(screen.getByRole("button", { name: L.drill(L.targetStat) })).toHaveTextContent("42");
  });

  it("expand caret reveals the linked draft's real rule line + metadata (no fabrication)", async () => {
    setupAuth();
    renderBody();
    const row = (await screen.findByText("Work order view")).closest("li");
    if (!row) throw new Error("row not found");

    await userEvent.click(within(row).getByRole("button", { name: L.expandAria("Work order view") }));
    expect(within(row).getByText("policy.wo_view")).toBeVisible();
  });

  it("renders an error state with retry when the catalog fetch fails", async () => {
    const { GET } = setupAuth({ catalogReject: true });
    renderBody();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(W.loadFailed);

    GET.mockImplementation(async (path: string) => {
      await Promise.resolve();
      if (path === "/api/v1/policy/catalog") return { data: catalog };
      if (path === "/api/v1/policy/drafts") return { data: drafts };
      if (path === "/api/v1/employees") return { data: { items: [], total: 1284, limit: 1, offset: 0 } };
      throw new Error(`unexpected GET ${path}`);
    });
    await userEvent.click(screen.getByRole("button", { name: W.retry }));
    await waitFor(() => {
      expect(screen.getByText("Work order view")).toBeVisible();
    });
  });

  it("새 정책 opens the reused policycanvas studio (no duplicate editor)", async () => {
    setupAuth();
    renderBody();
    await screen.findByText("Work order view");

    // The 새 정책 button lives behind <PolicyGated>, whose bulk-authorize gate
    // resolves on a separate async chain from the catalog load that
    // findByText("Work order view") awaits — so wait for the gated button to
    // appear rather than grabbing it synchronously (deny-by-omission until Allow).
    await userEvent.click(await screen.findByRole("button", { name: S.newPolicyName }));
    expect(await screen.findByLabelText(S.canvasLabel)).toBeVisible();
  });
});
