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
  roles?: string[];
}

function setupAuth(overrides: AuthOverrides = {}) {
  const { employeeTotal = 1284, roles = ["SUPER_ADMIN"] } = overrides;
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
    session: { user_id: "self-user", org_id: "org-1", roles },
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

    // The 새 정책 CTA lives behind a LOCAL role gate (not the Cedar
    // bulk-authorize gate — see PolicyBody's module doc): synchronous on
    // session.roles, so it renders immediately, no async authorize round
    // trip to await.
    await userEvent.click(await screen.findByRole("button", { name: S.newPolicyName }));
    expect(await screen.findByLabelText(S.canvasLabel)).toBeVisible();
  });

  it("새 정책 CTA renders for the SUPER_ADMIN session this screen's nav gate already requires (verdict r13: CTA missing)", async () => {
    setupAuth();
    renderBody();
    await screen.findByText("Work order view");
    // Deny-by-omission would otherwise leave the CTA absent forever — Cedar
    // has no enforced grant for policy.author for any principal yet (shadow
    // lane). This screen's own nav entry is SUPER_ADMIN-only, so the one role
    // that can reach it must see the CTA.
    expect(screen.getByRole("button", { name: S.newPolicyName })).toBeVisible();
  });

  it("새 정책 CTA is absent for a role below this screen's own nav gate (deny-by-omission holds)", async () => {
    setupAuth({ roles: ["ADMIN"] });
    renderBody();
    await screen.findByText("Work order view");
    expect(screen.queryByRole("button", { name: S.newPolicyName })).toBeNull();
  });

  it("shows an aggregate 허용/금지 footer under the list (verdict r13 lower half sparse)", async () => {
    setupAuth();
    renderBody();
    await screen.findByText("Work order view");
    // 2 catalog entries (1 permit/enforced, 1 forbid/shadow) + 1 standalone
    // draft (permit, unfiltered by the "all" default) = 3 rows: 2 permit, 1 forbid.
    expect(
      screen.getByText(`${S.effectLabels.permit} 2 · ${S.effectLabels.forbid} 1 · ${L.count(3)}`),
    ).toBeVisible();
  });
});
