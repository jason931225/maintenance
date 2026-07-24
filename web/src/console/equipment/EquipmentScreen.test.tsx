import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { equipmentStrings as text } from "../../i18n/equipment";
import {
  createEquipmentApi,
  type CaseDetailView,
  type CaseView,
  type DispositionView,
  type HistoryEntry,
  type UnitDetailView,
  type UnitView,
} from "./equipmentApi";
import type { EquipmentCapabilities } from "./equipmentCapabilities";
import { EquipmentScreen } from "./EquipmentScreen";

const fetchMock = vi.fn();

const operator: EquipmentCapabilities = {
  canObserve: true,
  canRegister: true,
  canQuote: true,
  canApprove: true,
  canDispatch: true,
  canInspect: true,
  canAssess: true,
  canDisposition: true,
};
const viewer: EquipmentCapabilities = {
  ...operator,
  canRegister: false,
  canQuote: false,
  canApprove: false,
  canDispatch: false,
  canInspect: false,
  canAssess: false,
  canDisposition: false,
};
const denied: EquipmentCapabilities = { ...viewer, canObserve: false };

const unit1: UnitView = {
  id: "unit-1",
  serialNo: "FL-001",
  modelName: "D30S-7",
  capacityClass: "3.0t",
  availability: "AVAILABLE",
  acquisitionCostMinor: 30_000_000,
  branchId: "branch-1",
};

const case1: CaseView = {
  id: "case-1",
  unitId: "unit-1",
  status: "QUOTED",
  customerName: "한국중공업",
  siteReference: "창원 1공장",
  monthlyRateMinor: 2_500_000,
  durationMonths: 12,
  currencyCode: "KRW",
  branchId: "branch-1",
};

function unitDetail(overrides: Partial<UnitDetailView> = {}): UnitDetailView {
  return {
    ...unit1,
    activeCaseId: null,
    openDispositionId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function caseDetail(overrides: Partial<CaseDetailView> = {}): CaseDetailView {
  return {
    ...case1,
    approval: null,
    dispatch: null,
    handover: null,
    returnedAt: null,
    assessment: null,
    dispositionId: null,
    inspections: [],
    createdBy: "creator-1",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function closedResaleCase(): CaseDetailView {
  return caseDetail({
    status: "CLOSED",
    returnedAt: "2026-07-22T00:00:00.000Z",
    assessment: {
      conditionGrade: "B",
      findings: "마모",
      disposition: "RESALE",
      assessedBy: "actor-2",
      assessedAt: "2026-07-22T01:00:00.000Z",
    },
    dispositionId: "disp-1",
  });
}

const completedResale: DispositionView = {
  id: "disp-1",
  unitId: "unit-1",
  caseId: "case-1",
  kind: "RESALE",
  status: "COMPLETED",
  costMinor: null,
  saleAmountMinor: 9_000_000,
  buyerName: "매수기업",
  completedBy: "actor-1",
  completedAt: "2026-07-23T00:00:00.000Z",
  financeGlPosting: null,
};

const unitHistory: HistoryEntry[] = [
  {
    aggregateKind: "unit",
    aggregateId: "unit-1",
    transition: "REGISTERED",
    actorId: "actor-9",
    occurredAt: "2026-07-01T00:00:00.000Z",
  },
  {
    aggregateKind: "case",
    aggregateId: "case-1",
    transition: "QUOTED",
    actorId: "actor-9",
    occurredAt: "2026-07-21T00:00:00.000Z",
  },
];

type RouteHandler = (init: RequestInit) => Response;
type Routes = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respond(routes: Routes) {
  fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (handler === undefined) {
      return Promise.resolve(
        jsonResponse({ error: { code: "not_found", message: `no route ${key}` } }, 404),
      );
    }
    if (typeof handler === "function") {
      return Promise.resolve((handler as RouteHandler)(init ?? {}));
    }
    return Promise.resolve(jsonResponse(handler));
  });
}

function listRoutes(units: UnitView[] = [unit1], cases: CaseView[] = [case1]): Routes {
  return {
    "GET /api/v1/equipment-3r/units": units,
    "GET /api/v1/equipment-3r/rental-cases": cases,
  };
}

function renderScreen(capabilities: EquipmentCapabilities = operator) {
  const api = createEquipmentApi("token-1");
  return render(
    <EquipmentScreen
      api={api}
      branchId="branch-1"
      actorId="actor-1"
      capabilities={capabilities}
      sessionKey="session-a"
    />,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EquipmentScreen", () => {
  it("denies an unauthorized user before fetching or exposing actions", () => {
    respond({});
    renderScreen(denied);
    expect(screen.getByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("button", { name: text.registerUnit })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the availability board and rental pipeline with stat counts", async () => {
    respond(listRoutes());
    renderScreen(viewer);
    const unitRow = await screen.findByRole("button", { name: /FL-001/ });
    expect(unitRow).toHaveTextContent(text.availability.AVAILABLE);
    const caseRow = screen.getByRole("button", { name: /한국중공업/ });
    expect(caseRow).toHaveTextContent(text.caseStatus.QUOTED);
    const availabilityStats = screen.getByRole("list", { name: text.availabilityFilter });
    expect(within(availabilityStats).getByRole("button")).toHaveTextContent("1");
    const statusStats = screen.getByRole("list", { name: text.statusFilter });
    expect(within(statusStats).getByRole("button")).toHaveTextContent("1");
  });

  it("renders truthful empty states when the backend has no records", async () => {
    respond(listRoutes([], []));
    renderScreen(viewer);
    expect(await screen.findByText(text.unitsEmpty)).toBeVisible();
    expect(screen.getByText(text.casesEmpty)).toBeVisible();
  });

  it("surfaces a list load failure and recovers on retry", async () => {
    let unitCalls = 0;
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/units": () => {
        unitCalls += 1;
        return unitCalls === 1
          ? jsonResponse({ error: { code: "internal", message: "목록 오류" } }, 500)
          : jsonResponse([unit1]);
      },
    });
    renderScreen(viewer);
    expect(await screen.findByRole("alert")).toHaveTextContent("목록 오류");
    await userEvent.click(screen.getByRole("button", { name: text.retry }));
    expect(await screen.findByRole("button", { name: /FL-001/ })).toBeVisible();
  });

  it("keyboard-activates a unit into its detail with history readback", async () => {
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/units/unit-1": unitDetail(),
      "GET /api/v1/equipment-3r/units/unit-1/history": unitHistory,
    });
    renderScreen(viewer);
    const row = await screen.findByRole("button", { name: /FL-001/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    const detail = await screen.findByRole("article", { name: text.unitDetail });
    expect(within(detail).getByRole("heading", { name: "FL-001" })).toBeVisible();
    expect(within(detail).getByText("REGISTERED")).toBeVisible();
    expect(within(detail).getByRole("button", { name: "QUOTED" })).toBeVisible();
  });

  it("offers no register, quote, or approval affordances to a read-only viewer", async () => {
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/units/unit-1": unitDetail(),
      "GET /api/v1/equipment-3r/units/unit-1/history": unitHistory,
      "GET /api/v1/equipment-3r/rental-cases/case-1": caseDetail(),
    });
    renderScreen(viewer);
    await screen.findByRole("button", { name: /FL-001/ });
    expect(screen.queryByRole("button", { name: text.registerUnit })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /FL-001/ }));
    await screen.findByRole("article", { name: text.unitDetail });
    expect(screen.queryByRole("button", { name: text.quote })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /한국중공업/ }));
    await screen.findByRole("article", { name: text.caseDetail });
    expect(screen.queryByRole("button", { name: text.approve })).toBeNull();
  });

  it("offers no quote form on a unit that is not AVAILABLE, keeping the active-case link", async () => {
    respond({
      ...listRoutes([{ ...unit1, availability: "ON_RENT" }]),
      "GET /api/v1/equipment-3r/units/unit-1": unitDetail({
        availability: "ON_RENT",
        activeCaseId: "case-1",
      }),
      "GET /api/v1/equipment-3r/units/unit-1/history": [],
    });
    renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /FL-001/ }));
    const detail = await screen.findByRole("article", { name: text.unitDetail });
    expect(within(detail).queryByRole("button", { name: text.quote })).toBeNull();
    expect(within(detail).getByRole("button", { name: "case-1" })).toBeVisible();
  });

  it("keeps an active filter clearable and truthful after its last member leaves", async () => {
    let onRent = false;
    respond({
      "GET /api/v1/equipment-3r/units": () =>
        jsonResponse([onRent ? { ...unit1, availability: "ON_RENT" } : unit1]),
      "GET /api/v1/equipment-3r/rental-cases": () => jsonResponse([case1]),
    });
    renderScreen(viewer);
    const stats = () => screen.getByRole("list", { name: text.availabilityFilter });
    await screen.findByRole("button", { name: /FL-001/ });
    await userEvent.click(within(stats()).getByRole("button", { name: /가용/ }));
    onRent = true;
    await userEvent.click(screen.getByRole("button", { name: text.refresh }));
    expect(await screen.findByText(text.unitsFilteredEmpty)).toBeVisible();
    const staleChip = within(stats()).getByRole("button", { name: /가용/ });
    expect(staleChip).toHaveTextContent("0");
    expect(staleChip).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(staleChip);
    expect(await screen.findByRole("button", { name: /FL-001/ })).toBeVisible();
  });

  it("marks the quoted step as done on a declined case", async () => {
    respond({
      ...listRoutes([unit1], [{ ...case1, status: "DECLINED" }]),
      "GET /api/v1/equipment-3r/rental-cases/case-1": caseDetail({
        status: "DECLINED",
        approval: {
          decision: "DECLINED",
          reason: "재고 부족",
          decidedBy: "actor-2",
          decidedAt: "2026-07-22T00:00:00.000Z",
        },
      }),
    });
    renderScreen(viewer);
    await userEvent.click(await screen.findByRole("button", { name: /한국중공업/ }));
    const steps = await screen.findByRole("list", { name: text.steps });
    const quoted = within(steps).getByText(text.caseStatus.QUOTED);
    expect(quoted.className).toBe("equipment__step equipment__step--done");
    expect(within(steps).getByText(text.caseStatus.DECLINED)).toHaveAttribute("aria-current", "step");
  });

  it("hides approval controls from the quote creator (four-eyes) but not from others", async () => {
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/rental-cases/case-1": caseDetail({ createdBy: "actor-1" }),
    });
    const view = renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /한국중공업/ }));
    await screen.findByRole("article", { name: text.caseDetail });
    expect(screen.queryByRole("button", { name: text.approve })).toBeNull();
    view.unmount();
    window.sessionStorage.clear();
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/rental-cases/case-1": caseDetail({ createdBy: "someone-else" }),
    });
    renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /한국중공업/ }));
    expect(await screen.findByRole("button", { name: text.approve })).toBeVisible();
  });

  it("keeps the quote draft and Idempotency-Key across a remount and clears them on success", async () => {
    const posts: RequestInit[] = [];
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/units/unit-1": unitDetail(),
      "GET /api/v1/equipment-3r/units/unit-1/history": [],
      "GET /api/v1/equipment-3r/rental-cases/case-1": caseDetail(),
      "POST /api/v1/equipment-3r/rental-cases": (init: RequestInit) => {
        posts.push(init);
        return jsonResponse(case1, 201);
      },
    });
    const first = renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /FL-001/ }));
    await screen.findByRole("article", { name: text.unitDetail });
    await userEvent.type(screen.getByLabelText(text.customer), "한국중공업");
    await userEvent.type(screen.getByLabelText(text.site), "창원 1공장");
    const storedRaw = window.localStorage.getItem("equipment3r.quote-draft.branch-1.unit-1");
    expect(storedRaw).not.toBeNull();
    const stored = JSON.parse(storedRaw ?? "{}") as { idempotencyKey: string; customerName: string };
    expect(stored.customerName).toBe("한국중공업");
    expect(stored.idempotencyKey.length).toBeGreaterThanOrEqual(16);

    first.unmount();
    renderScreen(operator);
    const restoredDetail = await screen.findByRole("article", { name: text.unitDetail });
    expect(within(restoredDetail).getByLabelText(text.customer)).toHaveValue("한국중공업");
    await userEvent.type(within(restoredDetail).getByLabelText(text.monthlyRate), "2500000");
    await userEvent.type(within(restoredDetail).getByLabelText(text.durationMonths), "12");
    await userEvent.click(within(restoredDetail).getByRole("button", { name: text.quote }));
    await screen.findByRole("article", { name: text.caseDetail });
    expect(posts).toHaveLength(1);
    expect(new Headers(posts[0].headers).get("Idempotency-Key")).toBe(stored.idempotencyKey);
    expect(JSON.parse(posts[0].body as string)).toEqual({
      branchId: "branch-1",
      unitId: "unit-1",
      customerName: "한국중공업",
      siteReference: "창원 1공장",
      monthlyRateMinor: 2_500_000,
      durationMonths: 12,
      currencyCode: "KRW",
    });
    expect(window.localStorage.getItem("equipment3r.quote-draft.branch-1.unit-1")).toBeNull();
  });

  it("reconciles an approval from the backend response instead of local state", async () => {
    let approved = false;
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/rental-cases/case-1": () =>
        jsonResponse(
          approved
            ? caseDetail({
              status: "APPROVED",
              createdBy: "someone-else",
              approval: {
                decision: "APPROVED",
                reason: null,
                decidedBy: "actor-1",
                decidedAt: "2026-07-22T00:00:00.000Z",
              },
            })
            : caseDetail({ createdBy: "someone-else" }),
        ),
      "POST /api/v1/equipment-3r/rental-cases/case-1/approval": () => {
        approved = true;
        return jsonResponse({ ...case1, status: "APPROVED" });
      },
    });
    renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /한국중공업/ }));
    await userEvent.click(await screen.findByRole("button", { name: text.approve }));
    const detail = await screen.findByRole("article", { name: text.caseDetail });
    // The decision readback (decidedBy) only exists on the refetched backend
    // detail, so its presence proves reconciliation rather than local state.
    await waitFor(() => {
      expect(within(detail).getByText(/actor-1/)).toBeVisible();
    });
    expect(within(detail).queryByRole("button", { name: text.approve })).toBeNull();
  });

  it("shows a completed disposition as readback instead of a dead completion form", async () => {
    respond({
      ...listRoutes([unit1], [{ ...case1, status: "CLOSED" }]),
      "GET /api/v1/equipment-3r/rental-cases/case-1": closedResaleCase(),
      // The unit has no open disposition, so disp-1 must already be COMPLETED.
      "GET /api/v1/equipment-3r/units/unit-1": unitDetail({ availability: "SOLD", openDispositionId: null }),
    });
    renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /한국중공업/ }));
    const detail = await screen.findByRole("article", { name: text.caseDetail });
    expect(within(detail).getByText(text.dispositionStatus.COMPLETED)).toBeVisible();
    expect(within(detail).queryByRole("button", { name: text.completeDisposition })).toBeNull();
  });

  it("completes an open resale disposition and reconciles the backend view", async () => {
    const completionPosts: RequestInit[] = [];
    respond({
      ...listRoutes([{ ...unit1, availability: "FOR_SALE" }], [{ ...case1, status: "CLOSED" }]),
      "GET /api/v1/equipment-3r/rental-cases/case-1": closedResaleCase(),
      "GET /api/v1/equipment-3r/units/unit-1": unitDetail({
        availability: "FOR_SALE",
        openDispositionId: "disp-1",
      }),
      "POST /api/v1/equipment-3r/dispositions/disp-1/completion": (init: RequestInit) => {
        completionPosts.push(init);
        return jsonResponse(completedResale);
      },
    });
    renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /한국중공업/ }));
    const detail = await screen.findByRole("article", { name: text.caseDetail });
    expect(within(detail).getByText(text.dispositionStatus.OPEN)).toBeVisible();
    await userEvent.type(within(detail).getByLabelText(text.saleAmount), "9000000");
    await userEvent.type(within(detail).getByLabelText(text.buyer), "매수기업");
    await userEvent.click(within(detail).getByRole("button", { name: text.completeDisposition }));
    await waitFor(() => {
      expect(completionPosts).toHaveLength(1);
    });
    expect(JSON.parse(completionPosts[0].body as string)).toEqual({
      saleAmountMinor: 9_000_000,
      buyerName: "매수기업",
    });
    expect(await within(detail).findByText(/9,000,000원/)).toBeVisible();
    expect(within(detail).queryByRole("button", { name: text.completeDisposition })).toBeNull();
  });

  it("declines require a reason before any request leaves the client", async () => {
    const approvalPosts: RequestInit[] = [];
    respond({
      ...listRoutes(),
      "GET /api/v1/equipment-3r/rental-cases/case-1": caseDetail({ createdBy: "someone-else" }),
      "POST /api/v1/equipment-3r/rental-cases/case-1/approval": (init: RequestInit) => {
        approvalPosts.push(init);
        return jsonResponse({ ...case1, status: "DECLINED" });
      },
    });
    renderScreen(operator);
    await userEvent.click(await screen.findByRole("button", { name: /한국중공업/ }));
    await userEvent.click(await screen.findByRole("button", { name: text.decline }));
    expect(await screen.findByText(text.reasonRequired)).toBeVisible();
    expect(approvalPosts).toHaveLength(0);
    await userEvent.type(screen.getByLabelText(text.declineReason), "재고 부족");
    await userEvent.click(screen.getByRole("button", { name: text.decline }));
    await waitFor(() => {
      expect(approvalPosts).toHaveLength(1);
    });
    expect(JSON.parse(approvalPosts[0].body as string)).toEqual({
      decision: "DECLINED",
      reason: "재고 부족",
    });
  });
});
