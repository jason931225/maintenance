import { fireEvent, render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { ko } from "../i18n/ko";
import { ConfigConsolePage } from "./ConfigConsolePage";

const S = ko.console.configconsole;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

afterEach(() => {
  server.resetHandlers();
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

function renderPage() {
  const auth: AuthContextValue = {
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
  return render(
    <AuthContext.Provider value={auth}>
      <ConfigConsolePage />
    </AuthContext.Provider>,
  );
}

const WORK_ORDER_TYPE_ID = "11111111-1111-4111-8111-111111111111";

const objectTypeSummaries = [
  {
    id: WORK_ORDER_TYPE_ID,
    stable_key: "work_order",
    title: "작업 지시",
    backing_kind: "instance",
    schema_version: 1,
    lifecycle_state: "published",
  },
];

const workOrderDetail = {
  object_type: objectTypeSummaries[0],
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
          { id: "pri-urgent", name: "긴급", color: "danger" },
          { id: "pri-normal", name: "보통" },
        ],
      },
      backing_column: null,
      required: false,
      in_property_policy: false,
    },
  ],
  links: [],
  actions: [],
  analytics: [],
};

function instanceState(id: string, title: string, priority: string) {
  return {
    instance: {
      id,
      object_type_id: WORK_ORDER_TYPE_ID,
      title,
      current_revision_id: `${id}-rev`,
      lifecycle_state: "active",
    },
    revision: {
      id: `${id}-rev`,
      instance_id: id,
      version: 1,
      attributes: { priority },
      valid_from: "2026-07-09T00:00:00Z",
      valid_to: null,
      action_type_id: null,
      actor: null,
      reason: null,
      prev_hash: "0".repeat(64),
      row_hash: "a".repeat(64),
    },
  };
}

function installHandlers() {
  server.use(
    http.get("*/api/v1/ontology/object-types", () =>
      HttpResponse.json(objectTypeSummaries),
    ),
    http.get("*/api/v1/ontology/object-types/work_order", () =>
      HttpResponse.json(workOrderDetail),
    ),
    http.get("*/api/v1/ontology/instances", ({ request }) => {
      const type = new URL(request.url).searchParams.get("type");
      if (type !== WORK_ORDER_TYPE_ID) return HttpResponse.json([]);
      return HttpResponse.json([
        instanceState("aaaaaaaa-0000-4000-8000-000000004101", "WO-4101", "pri-urgent"),
        instanceState("aaaaaaaa-0000-4000-8000-000000004102", "WO-4102", "pri-urgent"),
        instanceState("aaaaaaaa-0000-4000-8000-000000004103", "WO-4103", "pri-normal"),
      ]);
    }),
  );
}

describe("ConfigConsolePage (Phase C — real ontology instance query)", () => {
  it("computes widget counts from the mocked instance payload and drills to the rows", async () => {
    installHandlers();
    renderPage();

    // live count widget: total from the mocked GET /ontology/instances rows,
    // grouped per registry choice — registry titles/choice names come from the
    // mocked object-type detail payload, not local constants.
    expect(
      (await screen.findAllByRole("button", { name: S.widget.totalAria("작업 지시", 3) }))
        .length,
    ).toBeGreaterThan(0);
    const urgent = screen.getByRole("button", { name: S.widget.countAria("긴급", 2) });
    expect(screen.getByRole("button", { name: S.widget.countAria("보통", 1) })).toBeTruthy();

    // drill = filter routing over the fetched rows.
    fireEvent.click(urgent);
    const panel = screen.getByRole("article", { name: S.drill.panelTitle });
    expect(within(panel).getByText(S.drill.countChip(2))).toBeTruthy();
    const list = within(panel).getByRole("list", { name: S.drill.listAria });
    expect(within(list).getByText("WO-4101")).toBeTruthy();
    expect(within(list).getByText("WO-4102")).toBeTruthy();
    expect(within(list).queryByText("WO-4103")).toBeNull();
  });

  it("shows the error state with retry when the registry read fails, then recovers", async () => {
    server.use(
      http.get("*/api/v1/ontology/object-types", () =>
        HttpResponse.json({ code: "internal", message: "boom" }, { status: 500 }),
      ),
    );
    renderPage();

    expect(await screen.findByRole("alert")).toBeTruthy();

    installHandlers();
    fireEvent.click(screen.getByRole("button", { name: ko.page.retry }));
    expect(
      (await screen.findAllByRole("button", { name: S.widget.totalAria("작업 지시", 3) }))
        .length,
    ).toBeGreaterThan(0);
  });
});
