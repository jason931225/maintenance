import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { PANEL_DEFAULT_WIDTH, QUADRANT_GAP, WindowManagerProvider } from "../window";
import {
  OBJECT_EXPLORER_ACTIONS,
  ObjectExplorerScreen,
  buildObjectExplorerView,
  layoutObjectExplorerNodes,
  type ObjectExplorerModel,
} from "./ObjectExplorerScreen";

const allowGate: PolicyGate = { can: () => true };
const denyGate: PolicyGate = { can: () => false };
const TOKEN = "search-token";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

const graphModel: ObjectExplorerModel = {
  nodes: [
    {
      id: "c207",
      type: "contract",
      code: "C-207",
      label: "근로계약 C-207",
      lifecycle: { phase: "active", version: "v3" },
      automation_chips: ["wf-contract-review"],
    },
    {
      id: "att_cho",
      type: "attendance",
      code: "AT-CHO",
      label: "조이슨 근태",
      lifecycle: { phase: "review", version: "v1" },
    },
    {
      id: "pay_cho",
      type: "payroll",
      code: "PAY-CHO",
      label: "조이슨 급여",
    },
    {
      id: "audit_cho",
      type: "audit_event",
      code: "AE-77",
      label: "급여 열람 감사",
    },
  ],
  object_links: [
    {
      id: "link-contract-attendance",
      source_id: "c207",
      target_id: "att_cho",
      relation: "employment.attendance",
    },
    {
      id: "link-attendance-payroll",
      source_id: "att_cho",
      target_id: "pay_cho",
      relation: "attendance.payroll",
    },
    {
      id: "link-audit-attendance",
      source_id: "audit_cho",
      target_id: "att_cho",
      relation: "audit.subject",
    },
  ],
  object_types: [
    {
      id: "work_order",
      code: "OT-01",
      label: "작업지시",
      lifecycle: { phase: "active", version: "v2" },
      active_object_count: 24,
      trigger_bindings: ["WO- 생성 트리거", "SLA 지연 트리거"],
      governance_chips: ["Cedar"],
    },
    {
      id: "dispatch",
      code: "OT-13",
      label: "배차",
      lifecycle: { phase: "archived", version: "v1" },
      active_object_count: 0,
      trigger_bindings: ["WO- 통합 완료"],
    },
  ],
  series_cards: [
    {
      id: "payroll_run",
      code: "SR-205",
      label: "급여 회차",
      lifecycle: { phase: "active", version: "v1" },
      member_codes: ["PS-2026-06", "PS-2026-07"],
      trigger_bindings: ["PS- 산출 트리거"],
    },
  ],
};

describe("ObjectExplorerScreen", () => {
  it("builds an object_links traversal view with radial coordinates around the focused object", () => {
    const view = buildObjectExplorerView(graphModel, "att_cho");
    const layout = layoutObjectExplorerNodes(view);

    expect(view.focus.id).toBe("att_cho");
    expect(view.upstream.map((link) => link.node.id)).toEqual(["c207", "audit_cho"]);
    expect(view.downstream.map((link) => link.node.id)).toEqual(["pay_cho"]);
    // Focus is centred; every other node is spread on a radial ring around it
    // (non-zero distance from centre) with no two nodes sharing a position —
    // the fix for the old column/bottom-band pile-up.
    expect(layout.find((node) => node.id === "att_cho")).toMatchObject({ x: 50, y: 50 });
    const neighbours = layout.filter((node) => node.id !== "att_cho");
    for (const node of neighbours) {
      const distance = Math.hypot(node.x - 50, node.y - 50);
      expect(distance).toBeGreaterThan(0);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(100);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(100);
    }
    const positions = new Set(neighbours.map((node) => `${node.x.toFixed(2)},${node.y.toFixed(2)}`));
    expect(positions.size).toBe(neighbours.length);
  });

  it("renders upstream/downstream relation controls and re-centers from real object_links", () => {
    const onFocusChange = vi.fn();
    render(
      <PolicyGateProvider gate={allowGate}>
        <ObjectExplorerScreen
          model={graphModel}
          initialFocusId="c207"
          onFocusChange={onFocusChange}
        />
      </PolicyGateProvider>,
    );

    expect(screen.getByText("객체 탐색")).toBeInTheDocument();
    const graph = screen.getByLabelText("객체 관계 그래프");
    expect(within(graph).getByText("근로계약 C-207")).toBeInTheDocument();
    expect(within(graph).getByText("조이슨 근태")).toBeInTheDocument();
    const attendanceButton = screen.getByLabelText("조이슨 근태 중심으로 이동");
    expect(attendanceButton).toBeInTheDocument();

    fireEvent.click(attendanceButton);

    expect(onFocusChange).toHaveBeenCalledWith("att_cho");
    expect(screen.getByLabelText("현재 중심 개체")).toHaveTextContent("조이슨 근태");
    expect(screen.getByLabelText("근로계약 C-207 중심으로 이동")).toBeInTheDocument();
    expect(screen.getByLabelText("조이슨 급여 중심으로 이동")).toBeInTheDocument();

    fireEvent.click(screen.getByText("이전 중심으로"));
    expect(screen.getByLabelText("현재 중심 개체")).toHaveTextContent("근로계약 C-207");
  }, 10000);

  it("omits every traversal affordance when policy denies graph navigation", () => {
    render(
      <PolicyGateProvider gate={denyGate}>
        <ObjectExplorerScreen model={graphModel} initialFocusId="c207" />
      </PolicyGateProvider>,
    );

    expect(screen.getByText("조이슨 근태")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "조이슨 근태 중심으로 이동" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "이전 중심으로" }),
    ).not.toBeInTheDocument();
  });

  it("uses a stable PolicyGated action name for recenter affordances", () => {
    const seen: string[] = [];
    const gate: PolicyGate = {
      can: (action) => {
        seen.push(action);
        return true;
      },
    };

    render(
      <PolicyGateProvider gate={gate}>
        <ObjectExplorerScreen model={graphModel} initialFocusId="c207" />
      </PolicyGateProvider>,
    );

    expect(seen).toContain(OBJECT_EXPLORER_ACTIONS.recenter);
  });

  it("renders config-driven OT and SR cards with lifecycle and trigger-binding chips", () => {
    render(
      <PolicyGateProvider gate={allowGate}>
        <ObjectExplorerScreen model={graphModel} initialFocusId="c207" />
      </PolicyGateProvider>,
    );

    const typeCard = screen.getByLabelText("OT-01 타입 카드");
    expect(within(typeCard).getByText("작업지시")).toBeVisible();
    expect(within(typeCard).getByText("활성")).toBeVisible();
    expect(within(typeCard).getByText("v2")).toBeVisible();
    expect(within(typeCard).getByText("WO- 생성 트리거")).toBeVisible();
    expect(within(typeCard).getByText("SLA 지연 트리거")).toBeVisible();

    const seriesCard = screen.getByLabelText("SR-205 시리즈 카드");
    expect(within(seriesCard).getByText("급여 회차")).toBeVisible();
    expect(within(seriesCard).getByText("구성 2개")).toBeVisible();
    expect(within(seriesCard).getByText("PS- 산출 트리거")).toBeVisible();
  });

  it("creates a generic OB draft node from the active OT card and focuses it", () => {
    const onNodeCreate = vi.fn();
    render(
      <PolicyGateProvider gate={allowGate}>
        <ObjectExplorerScreen model={graphModel} initialFocusId="c207" onNodeCreate={onNodeCreate} />
      </PolicyGateProvider>,
    );

    fireEvent.change(screen.getByLabelText("새 객체 이름"), { target: { value: "현장 점검 노트" } });
    fireEvent.click(screen.getByRole("button", { name: "+ 새 객체" }));

    expect(onNodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "OB-001",
        label: "현장 점검 노트",
        lifecycle: { phase: "draft", version: "v1" },
        trigger_bindings: ["WO- 생성 트리거", "SLA 지연 트리거"],
      }),
    );
    expect(screen.getByLabelText("현재 중심 개체")).toHaveTextContent("현장 점검 노트");
    expect(screen.getByLabelText("현재 중심 개체")).toHaveTextContent("OB-001");
  });

  it("omits generic OB creation controls when no active OT card is available", () => {
    const archivedOnlyModel: ObjectExplorerModel = {
      ...graphModel,
      object_types: [
        {
          id: "dispatch",
          code: "OT-13",
          label: "배차",
          lifecycle: { phase: "archived", version: "v1" },
          active_object_count: 0,
          trigger_bindings: ["WO- 통합 완료"],
        },
      ],
    };

    render(
      <PolicyGateProvider gate={allowGate}>
        <ObjectExplorerScreen model={archivedOnlyModel} initialFocusId="c207" />
      </PolicyGateProvider>,
    );

    expect(screen.queryByRole("button", { name: "+ 새 객체" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("새 객체 타입")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("새 객체 이름")).not.toBeInTheDocument();
  });

  it("omits generic OB creation controls when policy denies node creation", () => {
    render(
      <PolicyGateProvider gate={denyGate}>
        <ObjectExplorerScreen model={graphModel} initialFocusId="c207" />
      </PolicyGateProvider>,
    );

    expect(screen.queryByRole("button", { name: "+ 새 객체" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("새 객체 이름")).not.toBeInTheDocument();
  });

  it("searches the real global endpoint and re-centers on the selected endpoint hit", async () => {
    const requests: Array<{ q: string | null; limit: string | null; authorization: string | null }> = [];
    server.use(
      http.get("*/api/v1/search", ({ request }) => {
        const url = new URL(request.url);
        requests.push({
          q: url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
          authorization: request.headers.get("authorization"),
        });
        return HttpResponse.json({
          results: [
            {
              kind: "work_order",
              id: "wo-endpoint",
              code: "WO-20260709-001",
              title: "엔드포인트 작업지시",
              status: "ACTIVE",
              exists: true,
            },
          ],
        });
      }),
    );

    const onFocusChange = vi.fn();
    render(
      <PolicyGateProvider gate={allowGate}>
        <ObjectExplorerScreen
          bearerToken={TOKEN}
          model={graphModel}
          initialFocusId="c207"
          onFocusChange={onFocusChange}
        />
      </PolicyGateProvider>,
    );

    fireEvent.change(screen.getByLabelText("객체 검색"), { target: { value: "조이슨" } });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));

    const results = await screen.findByRole("region", { name: "검색 결과" });
    expect(within(results).getByText("엔드포인트 작업지시")).toBeVisible();
    expect(within(results).queryByText("조이슨 근태")).not.toBeInTheDocument();
    expect(requests).toEqual([
      { q: "조이슨", limit: "10", authorization: `Bearer ${TOKEN}` },
    ]);

    fireEvent.click(
      within(results).getByRole("button", { name: "엔드포인트 작업지시 중심으로 이동" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("현재 중심 개체")).toHaveTextContent("엔드포인트 작업지시");
    });
    expect(screen.getByRole("region", { name: "객체 관계 그래프" })).toHaveTextContent(
      "엔드포인트 작업지시",
    );
    expect(onFocusChange).toHaveBeenCalledWith("wo-endpoint");
  });

  it("never renders a raw UUID for a search hit with no canonical code (support tickets today)", async () => {
    server.use(
      http.get("*/api/v1/search", () =>
        HttpResponse.json({
          results: [
            {
              kind: "support_ticket",
              id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
              title: "코드 없는 티켓",
              status: "OPEN",
              exists: true,
            },
          ],
        }),
      ),
    );

    render(
      <PolicyGateProvider gate={allowGate}>
        <ObjectExplorerScreen bearerToken={TOKEN} model={graphModel} initialFocusId="c207" />
      </PolicyGateProvider>,
    );

    fireEvent.change(screen.getByLabelText("객체 검색"), { target: { value: "코드" } });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));

    const results = await screen.findByRole("region", { name: "검색 결과" });
    expect(within(results).getByText("코드 없는 티켓")).toBeVisible();
    expect(
      within(results).queryByText("3fa85f64-5717-4562-b3fc-2c963f66afa6"),
    ).not.toBeInTheDocument();
  });
});

describe("ObjectExplorerScreen pinned-window integration (§4.7 catalog #2)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function renderWithWindows() {
    return render(
      <WindowManagerProvider>
        <PolicyGateProvider gate={allowGate}>
          <ObjectExplorerScreen model={graphModel} initialFocusId="c207" />
        </PolicyGateProvider>
      </WindowManagerProvider>,
    );
  }

  // The hostStyle div wraps the whole screen; padding-right IS the real split
  // (jsdom innerWidth 1024 → not narrow), not an overlay.
  function hostWrapper(): HTMLElement {
    const host = screen.getByRole("main").parentElement;
    if (!host) throw new Error("host wrapper missing");
    return host;
  }

  it("opens a clicked node as a right pin panel and gives the host real split padding", () => {
    renderWithWindows();

    expect(hostWrapper().style.paddingRight).toBe("");
    expect(screen.queryByRole("region", { name: "조이슨 근태" })).not.toBeInTheDocument();

    // §4.7-3: clicking an object is the default open gesture → right pin panel.
    fireEvent.click(screen.getByLabelText("조이슨 근태 중심으로 이동"));

    const panel = screen.getByRole("region", { name: "조이슨 근태" });
    expect(panel).toBeVisible();
    expect(within(panel).getByText("AT-CHO")).toBeVisible();
    expect(hostWrapper().style.paddingRight).toBe(`${String(PANEL_DEFAULT_WIDTH + QUADRANT_GAP)}px`);
  });

  it("round-trips the pinned panel through minimize → tray chip → restore", () => {
    renderWithWindows();
    fireEvent.click(screen.getByLabelText("조이슨 근태 중심으로 이동"));

    fireEvent.click(screen.getByRole("button", { name: "최소화" }));

    expect(screen.queryByRole("region", { name: "조이슨 근태" })).not.toBeInTheDocument();
    expect(hostWrapper().style.paddingRight).toBe("");
    const tray = screen.getByRole("group", { name: "작업 트레이" });
    const chip = within(tray).getByRole("button", { name: "조이슨 근태 복원" });

    fireEvent.click(chip);

    expect(screen.getByRole("region", { name: "조이슨 근태" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "작업 트레이" })).not.toBeInTheDocument();
  });

  it("restores the default (grid) arrangement when the panel is closed", () => {
    renderWithWindows();
    fireEvent.click(screen.getByLabelText("조이슨 근태 중심으로 이동"));

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(screen.queryByRole("region", { name: "조이슨 근태" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "작업 트레이" })).not.toBeInTheDocument();
    expect(hostWrapper().style.paddingRight).toBe("");
  });
});
