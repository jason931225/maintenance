import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createConsoleApiClient } from "../api/client";
import { PolicyGateProvider, type PolicyGate } from "../console/policy";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { ko } from "../i18n/ko";
import { AutomateHub, AutomatePage } from "./AutomatePage";

const S = ko.console.automate;
const W = ko.workflowStudio;

const mockStepUpAssertion = {
  ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credential: { id: "credential", type: "public-key" },
};
const mockAssertPasskeyStepUp = vi.hoisted(() => vi.fn());
vi.mock("../auth/webauthn", () => ({
  assertPasskeyStepUp: mockAssertPasskeyStepUp,
}));

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  mockAssertPasskeyStepUp.mockResolvedValue(mockStepUpAssertion);
});

afterEach(() => {
  server.resetHandlers();
  mockAssertPasskeyStepUp.mockReset();
});

afterAll(() => {
  server.close();
});

const session: AuthSession = {
  access_token: "token",
  user_id: "00000000-0000-4000-8000-0000000000aa",
  display_name: "개발자",
  roles: ["SUPER_ADMIN"],
  group_roles: [],
  feature_grants: [],
  org_id: "00000000-0000-0000-0000-0000000000a1",
  branches: ["00000000-0000-4000-8000-000000000001"],
  isPlatform: false,
};

function authValue(): AuthContextValue {
  return {
    session,
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api: createConsoleApiClient(() => session.access_token),
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  };
}

function renderPage() {
  return render(
    <AuthContext.Provider value={authValue()}>
      <AutomatePage />
    </AuthContext.Provider>,
  );
}

function renderHub(gate: PolicyGate) {
  return render(
    <AuthContext.Provider value={authValue()}>
      <PolicyGateProvider gate={gate}>
        <AutomateHub />
      </PolicyGateProvider>
    </AuthContext.Provider>,
  );
}

// ── Ontology registry fixtures (condition fields + effect action types) ─────

const WORK_ORDER_TYPE_ID = "0f0f0f0f-0000-4000-8000-000000000001";

const objectTypeSummary = {
  id: WORK_ORDER_TYPE_ID,
  stable_key: "work_order",
  title: "작업지시",
  backing_kind: "instance",
  schema_version: 1,
  lifecycle_state: "published",
};

const objectTypeDetail = {
  object_type: objectTypeSummary,
  title_property_key: null,
  backing_table: null,
  primary_key_property: null,
  properties: [
    {
      id: "prop-priority",
      key: "priority",
      title: "우선순위",
      field_type: "choice",
      config: {
        choices: [
          { id: "pri-urgent", name: "긴급" },
          { id: "pri-normal", name: "보통" },
        ],
      },
      backing_column: null,
      required: false,
      in_property_policy: false,
    },
    {
      id: "prop-days-open",
      key: "days_open",
      title: "경과일",
      field_type: "number",
      config: {},
      backing_column: null,
      required: false,
      in_property_policy: false,
    },
  ],
  links: [],
  actions: [
    {
      id: "act-escalate",
      stable_key: "escalate",
      title: "에스컬레이션",
      params_schema: {},
      edits: {},
      submission_criteria: {},
      side_effects: {},
      dispatch: "projected_usecase",
      dispatch_target: null,
      control_points: {},
    },
    {
      id: "act-notify",
      stable_key: "notify_assignee",
      title: "담당자 알림",
      params_schema: {},
      edits: {},
      submission_criteria: {},
      side_effects: {},
      dispatch: "instance_revision",
      dispatch_target: null,
      control_points: {},
    },
  ],
  analytics: [],
};

// ── Workflow-studio definition fixtures (automate envelope in definition JSON) ─

const overdueCondition = {
  join: "and",
  predicates: [
    { id: "p-1", field: "days_open", op: "gte", value: { kind: "number", value: 7 } },
  ],
};

const overdueDoc = {
  version: 1,
  nodes: [
    { id: "n-1", kind: "trigger", title: S.samples.trigger, x: 40, y: 32 },
    {
      id: "n-2",
      kind: "condition",
      title: "조건",
      chips: ["경과일 ≥ 7"],
      predicate: overdueCondition,
      x: 40,
      y: 208,
    },
    {
      id: "n-3",
      kind: "branch",
      title: "분기",
      outputs: [
        { port: "met", label: S.labels.branchMet },
        { port: "unmet", label: S.labels.branchUnmet },
      ],
      x: 40,
      y: 384,
    },
    {
      id: "n-4",
      kind: "action",
      title: "담당자 알림",
      chips: ["작업지시", S.labels.dispatch.instance_revision],
      x: 360,
      y: 384,
    },
  ],
  edges: [
    { id: "e-1", from: "n-1", to: "n-2" },
    { id: "e-2", from: "n-2", to: "n-3" },
    { id: "e-3", from: "n-3", fromPort: "met", to: "n-4" },
  ],
  vars: [],
};

const baseDefinition = {
  approval_line: [],
  payment_line: [],
  notification_rules: [],
  action_allowlist: [],
  required_approval_line: false,
  required_payment_line: false,
  pending_version: null,
  pending_staged_by: null,
  created_at: "2026-07-08T09:00:00Z",
  updated_at: "2026-07-08T09:00:00Z",
};

const overdueRule = {
  ...baseDefinition,
  id: "11111111-1111-4111-8111-111111111111",
  workflow_key: "automate.rule.overdue",
  display_name: "지연 작업지시 알림",
  object_type: "work_order",
  status: "DRAFT",
  latest_version: 1,
  active_version: null,
  definition: {
    schema_version: "workflow.definition.v1",
    trigger: "automate.object_change",
    steps: [],
    automate: { scope: "org", doc: overdueDoc, condition: overdueCondition },
  },
};

const personalRule = {
  ...baseDefinition,
  id: "22222222-2222-4222-8222-222222222222",
  workflow_key: "automate.rule.personal",
  display_name: "개인 알림 규칙",
  object_type: "work_order",
  status: "ACTIVE",
  latest_version: 2,
  active_version: 2,
  definition: {
    schema_version: "workflow.definition.v1",
    trigger: "automate.object_change",
    steps: [],
    automate: { scope: "personal", doc: overdueDoc, condition: overdueCondition },
  },
};

const monitorDefinition = {
  ...baseDefinition,
  id: "33333333-3333-4333-8333-333333333333",
  workflow_key: "automate.monitor.urgent",
  display_name: "긴급 미배정 작업지시 감시",
  object_type: "work_order",
  status: "ACTIVE",
  latest_version: 1,
  active_version: 1,
  definition: {
    schema_version: "workflow.definition.v1",
    trigger: "work_order.monitor",
    steps: [],
    automate: {
      scope: "org",
      doc: overdueDoc,
      condition: {
        join: "and",
        predicates: [
          { id: "p-m1", field: "priority", op: "eq", value: { kind: "enum", value: "pri-urgent" } },
        ],
      },
      monitor: { object_type: "work_order", action_key: "escalate" },
    },
  },
};

const scheduleDefinition = {
  ...baseDefinition,
  id: "44444444-4444-4444-8444-444444444444",
  workflow_key: "automate.schedule.kpi",
  display_name: "일일 KPI 스냅샷",
  object_type: "work_order",
  status: "ACTIVE",
  latest_version: 1,
  active_version: 1,
  definition: {
    schema_version: "workflow.definition.v1",
    trigger: "automate.object_change",
    steps: [],
    automate: { scope: "org", doc: null, condition: null, rule_id: overdueRule.id },
    schedule: {
      name: "일일 KPI 스냅샷",
      active: true,
      cron: "0 9 * * *",
      cron_label: "매일",
      next_run_at: "07-10 09:00",
      last_run_at: "07-09 09:00",
    },
  },
};

const failedRun = {
  id: "99999999-9999-4999-8999-999999999901",
  code: "RUN-001",
  definition_id: overdueRule.id,
  definition_version: 1,
  trigger_type: "MANUAL",
  status: "FAILED",
  actor_display_name: "자동화 엔진",
  summary: "웹훅 호출 실패",
  error_message: "connector timeout",
  generated_objects: ["WO-2643"],
  started_at: "2026-07-09T08:10:00Z",
  updated_at: "2026-07-09T08:10:00.800Z",
  completed_at: null,
  failed_at: "2026-07-09T08:10:00.800Z",
};

const succeededRun = {
  ...failedRun,
  id: "99999999-9999-4999-8999-999999999902",
  code: "RUN-002",
  status: "SUCCEEDED",
  summary: "조건 충족 · 액션 실행",
  error_message: null,
  generated_objects: ["WO-2650"],
  completed_at: "2026-07-09T09:00:01.300Z",
  failed_at: null,
};

function installOntologyHandlers() {
  server.use(
    http.get("*/api/v1/ontology/object-types", () =>
      HttpResponse.json([objectTypeSummary]),
    ),
    http.get("*/api/v1/ontology/object-types/work_order", () =>
      HttpResponse.json(objectTypeDetail),
    ),
  );
}

function installBaseHandlers(
  items: unknown[] = [overdueRule, personalRule, monitorDefinition, scheduleDefinition],
  runLogByDefinitionId: Record<string, unknown[]> = { [overdueRule.id]: [failedRun] },
) {
  installOntologyHandlers();
  server.use(
    http.get("*/api/v1/workflow-studio/definitions", () =>
      HttpResponse.json({ items }),
    ),
    http.get("*/api/v1/workflow-studio/definitions/:id/run-log", ({ params }) =>
      HttpResponse.json({ items: runLogByDefinitionId[String(params.id)] ?? [] }),
    ),
  );
}

describe("AutomatePage (Phase C — real workflow-studio wiring)", () => {
  it("renders rules from GET /definitions with the persisted canvas doc and the real run log", async () => {
    installBaseHandlers();
    renderPage();

    // tabs + rule list rows come from the definitions payload.
    expect(await screen.findByRole("tab", { name: S.tabs.rules, selected: true })).toBeVisible();
    expect(screen.getByRole("tab", { name: S.tabs.schedules })).toBeVisible();
    expect(screen.getByRole("tab", { name: S.tabs.monitors })).toBeVisible();
    const row = screen.getByRole("button", {
      name: S.actions.selectRule(overdueRule.display_name),
    });
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(within(row).getByText(S.scope.org)).toBeVisible();
    expect(within(row).getByText(S.status.draft)).toBeVisible();

    // builder canvas = the definition JSON's automate.doc, block for block.
    const builder = screen.getByRole("region", { name: overdueRule.display_name });
    expect(within(builder).getByText(S.samples.trigger)).toBeVisible();
    expect(within(builder).getByText(S.labels.branchMet)).toBeVisible();
    expect(within(builder).getByText(S.labels.branchUnmet)).toBeVisible();
    expect(within(builder).getAllByText("경과일 ≥ 7").length).toBeGreaterThan(0);
    expect(within(builder).getAllByText("담당자 알림").length).toBeGreaterThan(0);
    expect(
      within(builder).getAllByText(S.labels.dispatch.instance_revision).length,
    ).toBeGreaterThan(0);

    // run log = GET .../run-log rows: status, computed duration, summary, object chips.
    const runLog = await within(builder).findByRole("list", { name: S.sections.runLog });
    expect(await within(runLog).findByText(S.status.failed)).toBeVisible();
    expect(within(runLog).getByText(S.labels.duration(800))).toBeVisible();
    expect(within(runLog).getByText(/웹훅 호출 실패/)).toBeVisible();
    const chip = within(runLog).getByText("WO-2643");
    expect(chip).toHaveAttribute("draggable", "true");
  });

  it("renders the error state (not a crash) when GET /definitions fails, and retry recovers", async () => {
    installOntologyHandlers();
    let failed = false;
    server.use(
      http.get("*/api/v1/workflow-studio/definitions", () => {
        if (!failed) {
          failed = true;
          return HttpResponse.json(
            { error: { code: "internal", message: "boom" } },
            { status: 500 },
          );
        }
        return HttpResponse.json({ items: [overdueRule] });
      }),
      http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderPage();

    // API error → the console error state, no fabricated rule rows.
    expect(
      await screen.findByText(ko.console.workflows.errors.loadFailed),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: S.actions.selectRule(overdueRule.display_name),
      }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: ko.page.retry }));
    expect(
      await screen.findByRole("button", {
        name: S.actions.selectRule(overdueRule.display_name),
      }),
    ).toBeVisible();
  });

  it("simulates the selected rule through POST .../simulate and surfaces the decision", async () => {
    installBaseHandlers();
    server.use(
      http.post("*/api/v1/workflow-studio/definitions/:id/simulate", () =>
        HttpResponse.json({
          decision: "blocked",
          findings: [{ severity: "blocker", code: "allowlist", message: "허용 커넥터 없음" }],
        }),
      ),
    );
    renderPage();

    const builder = await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(within(builder).getByRole("button", { name: W.simulate }));
    expect(await screen.findByText("허용 커넥터 없음")).toBeVisible();
  });

  it("재시도 on a failed run triggers POST .../run and refreshes the run-log timeline", async () => {
    const runRequests: unknown[] = [];
    let retried = false;
    installOntologyHandlers();
    server.use(
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({ items: [overdueRule] }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
        HttpResponse.json({ items: retried ? [succeededRun, failedRun] : [failedRun] }),
      ),
      http.post("*/api/v1/workflow-studio/definitions/:id/run", async ({ request }) => {
        runRequests.push(await request.json());
        retried = true;
        return HttpResponse.json(succeededRun);
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: S.actions.retry }));

    await waitFor(() => {
      expect(runRequests).toHaveLength(1);
    });
    expect(runRequests[0]).toMatchObject({ trigger_type: "MANUAL" });
    expect(await screen.findByText(W.success.run)).toBeVisible();
    expect(await screen.findByText("WO-2650")).toBeVisible();
  });

  it("toggling a draft rule active publishes with passkey step-up", async () => {
    const publishRequests: unknown[] = [];
    installBaseHandlers([overdueRule], {});
    server.use(
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/publish",
        async ({ request }) => {
          publishRequests.push(await request.json());
          return HttpResponse.json({
            ...overdueRule,
            status: "ACTIVE",
            active_version: 1,
          });
        },
      ),
    );
    renderPage();

    const builder = await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(within(builder).getByRole("button", { name: S.actions.activate }));

    await waitFor(() => {
      expect(mockAssertPasskeyStepUp).toHaveBeenCalledTimes(1);
    });
    expect(publishRequests).toEqual([{ step_up: mockStepUpAssertion }]);
    expect(await screen.findByText(W.success.publish)).toBeVisible();
    expect(within(builder).getByRole("button", { name: S.actions.toDraft })).toBeVisible();
  });

  it("scope chips (전사/개인) narrow the rule list from the envelope scope", async () => {
    installBaseHandlers();
    renderPage();

    await screen.findByRole("button", { name: S.actions.selectRule(overdueRule.display_name) });
    await userEvent.click(screen.getByRole("button", { name: S.scope.personal }));
    expect(
      screen.queryByRole("button", { name: S.actions.selectRule(overdueRule.display_name) }),
    ).toBeNull();
    const row = screen.getByRole("button", {
      name: S.actions.selectRule(personalRule.display_name),
    });
    expect(row).toHaveAttribute("aria-pressed", "true");
  });

  it("§4-22 add path: 규칙 추가 POSTs a draft definition carrying the automate envelope", async () => {
    const createRequests: unknown[] = [];
    installBaseHandlers([overdueRule], {});
    server.use(
      http.post("*/api/v1/workflow-studio/definitions", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createRequests.push(body);
        return HttpResponse.json({
          ...overdueRule,
          id: "55555555-5555-4555-8555-555555555555",
          workflow_key: body.workflow_key,
          display_name: body.display_name,
          definition: body.definition,
          status: "DRAFT",
        });
      }),
    );
    renderPage();

    await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(screen.getByRole("button", { name: S.actions.addRule }));

    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    const body = createRequests[0] as {
      object_type: string;
      definition: { automate: { scope: string; doc: unknown; condition: unknown } };
    };
    expect(body.object_type).toBe("work_order");
    expect(body.definition.automate.scope).toBe("personal");
    expect(body.definition.automate.doc).toBeTruthy();
    expect(body.definition.automate.condition).toBeTruthy();
    expect(
      await screen.findByRole("region", { name: S.labels.newRuleName(2) }),
    ).toBeVisible();
  });

  it("action picker PATCHes the definition with the added ontology action block", async () => {
    const patchRequests: unknown[] = [];
    installBaseHandlers([overdueRule], {});
    server.use(
      http.patch(
        "*/api/v1/workflow-studio/definitions/:id",
        async ({ request }) => {
          const body = (await request.json()) as { definition: Record<string, unknown> };
          patchRequests.push(body);
          return HttpResponse.json({ ...overdueRule, definition: body.definition });
        },
      ),
    );
    renderPage();

    const builder = await screen.findByRole("region", { name: overdueRule.display_name });
    // before: escalate exists only as a picker option.
    expect(within(builder).getAllByText("에스컬레이션")).toHaveLength(1);
    await userEvent.selectOptions(
      within(builder).getByLabelText(S.labels.actionType),
      "act-escalate",
    );
    await userEvent.click(
      within(builder).getByRole("button", { name: S.actions.addActionBlock }),
    );

    await waitFor(() => {
      expect(patchRequests).toHaveLength(1);
    });
    const patched = patchRequests[0] as {
      definition: { automate: { doc: { nodes: { title: string }[] } } };
    };
    expect(
      patched.definition.automate.doc.nodes.some((node) => node.title === "에스컬레이션"),
    ).toBe(true);
    expect((await within(builder).findAllByText("에스컬레이션")).length).toBeGreaterThan(1);
  });

  it("분석·감시: monitor definitions render condition → effect chips with real run counts", async () => {
    installBaseHandlers(
      [overdueRule, monitorDefinition],
      { [monitorDefinition.id]: [succeededRun] },
    );
    renderPage();

    await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.monitors }));

    expect(await screen.findByText(monitorDefinition.display_name)).toBeVisible();
    // registry-resolved chips: object type title, choice-resolved predicate, effect action title.
    expect(screen.getAllByText("작업지시").length).toBeGreaterThan(0);
    expect(screen.getByText("우선순위 = 긴급")).toBeVisible();
    expect(screen.getByText("에스컬레이션")).toBeVisible();
    expect(await screen.findByText(S.labels.hits(1))).toBeVisible();
  });

  it("감시 규칙 만들기 POSTs a monitor-shaped definition and opens it in the builder", async () => {
    const createRequests: unknown[] = [];
    installBaseHandlers([overdueRule, monitorDefinition], {});
    server.use(
      http.post("*/api/v1/workflow-studio/definitions", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createRequests.push(body);
        return HttpResponse.json({
          ...monitorDefinition,
          id: "66666666-6666-4666-8666-666666666666",
          workflow_key: body.workflow_key,
          display_name: body.display_name,
          definition: body.definition,
          status: "DRAFT",
          active_version: null,
        });
      }),
    );
    renderPage();

    await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.monitors }));
    await userEvent.click(screen.getByRole("button", { name: S.actions.createMonitor }));

    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    const body = createRequests[0] as {
      definition: { automate: { monitor: { object_type: string; action_key: string } } };
    };
    expect(body.definition.automate.monitor).toEqual({
      object_type: "work_order",
      action_key: "escalate",
    });
    // back on the rules tab with the new monitor open in the builder.
    expect(screen.getByRole("tab", { name: S.tabs.rules, selected: true })).toBeVisible();
    expect(
      await screen.findByRole("region", { name: S.labels.newRuleName(3) }),
    ).toBeVisible();
  });

  it("빌더에서 편집 opens the SAME monitor definition in the rules-tab builder", async () => {
    installBaseHandlers([overdueRule, monitorDefinition], {});
    renderPage();

    await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.monitors }));
    await userEvent.click(
      (await screen.findAllByRole("button", { name: S.actions.editInBuilder }))[0],
    );

    expect(screen.getByRole("tab", { name: S.tabs.rules, selected: true })).toBeVisible();
    const builder = screen.getByRole("region", { name: monitorDefinition.display_name });
    expect(within(builder).getAllByText("경과일 ≥ 7").length).toBeGreaterThan(0);
  });

  it("예약: §3.9.0 editing an ACTIVE schedule PATCHes then stages a pendingRev via publish; approve applies it", async () => {
    const patchRequests: unknown[] = [];
    const approveRequests: string[] = [];
    let current: typeof scheduleDefinition = scheduleDefinition;
    installOntologyHandlers();
    server.use(
      http.get("*/api/v1/workflow-studio/definitions", () =>
        HttpResponse.json({ items: [overdueRule, scheduleDefinition] }),
      ),
      http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.patch(
        "*/api/v1/workflow-studio/definitions/:id",
        async ({ request }) => {
          const body = (await request.json()) as { definition: Record<string, unknown> };
          patchRequests.push(body);
          current = { ...current, definition: body.definition } as typeof scheduleDefinition;
          return HttpResponse.json(current);
        },
      ),
      http.post("*/api/v1/workflow-studio/definitions/:id/publish", () => {
        current = {
          ...current,
          pending_version: 2,
          pending_staged_by: "00000000-0000-4000-8000-0000000000bb",
        } as typeof scheduleDefinition;
        return HttpResponse.json(current);
      }),
      http.post(
        "*/api/v1/workflow-studio/definitions/:id/revisions/:rev/approve",
        ({ params }) => {
          approveRequests.push(String(params.rev));
          current = {
            ...current,
            latest_version: 2,
            active_version: 2,
            pending_version: null,
            pending_staged_by: null,
          };
          return HttpResponse.json(current);
        },
      ),
    );
    renderPage();

    await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.schedules }));
    const detail = await screen.findByRole("region", { name: "일일 KPI 스냅샷" });
    expect(within(detail).getByText(S.labels.cron("0 9 * * *"))).toBeVisible();

    await userEvent.click(within(detail).getByRole("button", { name: S.actions.edit }));
    const nameInput = within(detail).getByLabelText(S.labels.scheduleName);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "일일 KPI 스냅샷 v2");
    await userEvent.click(within(detail).getByRole("button", { name: S.actions.save }));

    // PATCH carried the schedule block; the ACTIVE definition then staged a revision.
    await waitFor(() => {
      expect(patchRequests).toHaveLength(1);
    });
    expect(patchRequests[0]).toMatchObject({
      definition: { schedule: { name: "일일 KPI 스냅샷 v2", cron: "0 9 * * *" } },
    });
    expect(mockAssertPasskeyStepUp).toHaveBeenCalled();
    // pendingRev chip shows in both the list row and the detail card.
    expect(
      (
        await screen.findAllByText(
          S.labels.pendingRevision(2, "00000000-0000-4000-8000-0000000000bb"),
        )
      ).length,
    ).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: S.actions.approveRevision }));
    await waitFor(() => {
      expect(approveRequests).toEqual(["2"]);
    });
    expect(await screen.findByText(S.labels.version(2))).toBeVisible();
    expect(
      screen.queryAllByText(
        S.labels.pendingRevision(2, "00000000-0000-4000-8000-0000000000bb"),
      ),
    ).toHaveLength(0);
  });

  it("예약: 지금 실행 POSTs a SCHEDULE-triggered run; 예약 추가 POSTs a schedule definition", async () => {
    const runRequests: unknown[] = [];
    const createRequests: unknown[] = [];
    installBaseHandlers([overdueRule, scheduleDefinition], {});
    server.use(
      http.post("*/api/v1/workflow-studio/definitions/:id/run", async ({ request }) => {
        runRequests.push(await request.json());
        return HttpResponse.json({ ...succeededRun, definition_id: scheduleDefinition.id });
      }),
      http.post("*/api/v1/workflow-studio/definitions", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createRequests.push(body);
        return HttpResponse.json({
          ...scheduleDefinition,
          id: "77777777-7777-4777-8777-777777777777",
          workflow_key: body.workflow_key,
          display_name: body.display_name,
          definition: body.definition,
          status: "DRAFT",
          active_version: null,
        });
      }),
    );
    renderPage();

    await screen.findByRole("region", { name: overdueRule.display_name });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.schedules }));
    const detail = await screen.findByRole("region", { name: "일일 KPI 스냅샷" });

    await userEvent.click(within(detail).getByRole("button", { name: S.actions.runNow }));
    await waitFor(() => {
      expect(runRequests).toHaveLength(1);
    });
    expect(runRequests[0]).toMatchObject({ trigger_type: "SCHEDULE" });

    const form = screen.getByRole("form", { name: S.sections.addSchedule });
    await userEvent.type(
      within(form).getByLabelText(S.labels.scheduleName),
      "주간 점검 예약",
    );
    await userEvent.selectOptions(within(form).getByLabelText(S.labels.cadence), "weekly");
    await userEvent.click(within(form).getByRole("button", { name: S.actions.addSchedule }));

    await waitFor(() => {
      expect(createRequests).toHaveLength(1);
    });
    expect(createRequests[0]).toMatchObject({
      display_name: "주간 점검 예약",
      definition: {
        schedule: { name: "주간 점검 예약", cron: "0 9 * * 1", active: true },
        automate: { rule_id: overdueRule.id },
      },
    });
    expect(
      await screen.findByRole("region", { name: "주간 점검 예약" }),
    ).toBeVisible();
  });

  it("deny-by-omission: hidden tabs fall through; no permitted tab shows the empty chip", async () => {
    installBaseHandlers();
    const noRules: PolicyGate = {
      can: (action) => action !== "console.automate.tab.rules.view",
    };
    const { unmount } = renderHub(noRules);
    expect(
      await screen.findByRole("tab", { name: S.tabs.schedules, selected: true }),
    ).toBeVisible();
    expect(screen.queryByRole("tab", { name: S.tabs.rules })).toBeNull();
    unmount();

    renderHub({ can: () => false });
    expect(await screen.findByText(S.labels.noAvailableTabs)).toBeVisible();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});
