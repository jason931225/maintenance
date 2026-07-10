import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GENESIS_HASH, type CreateObjectTypeDraft } from "../api/ontology";
import { createConsoleApiClient } from "../api/client";
import { WindowManagerProvider } from "../console/window";
import { AuthContext, type AuthContextValue, type AuthSession } from "../context/auth";
import { ko } from "../i18n/ko";
import { OntologyPage } from "./OntologyPage";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  localStorage.clear();
});

// ── Wire fixtures (backend serde shapes; see api/ontology.ts) ───────────────

const WO_TYPE_ID = "11111111-1111-4111-8111-111111111111";
const MEMO_TYPE_ID = "22222222-2222-4222-8222-222222222222";
const LINK_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const WO_INSTANCE_ID = "aaaa1111-2222-4333-8444-555555555555";
const MEMO_INSTANCE_ID = "bbbb1111-2222-4333-8444-555555555555";
const EDGE_ID = "cccc1111-2222-4333-8444-555555555555";
const ACTOR_ID = "dddd1111-2222-4333-8444-555555555555";

const ROW_HASH_V1 = "a".repeat(64);
const ROW_HASH_V2 = "b".repeat(64);

const woSummary = {
  id: WO_TYPE_ID,
  stable_key: "work_order",
  title: "작업지시",
  backing_kind: "projected",
  schema_version: 2,
  lifecycle_state: "published",
};

const memoSummary = {
  id: MEMO_TYPE_ID,
  stable_key: "safety_memo",
  title: "안전 점검 메모",
  backing_kind: "instance",
  schema_version: 1,
  lifecycle_state: "draft",
};

const woDetail = {
  object_type: woSummary,
  title_property_key: "title",
  backing_table: "work_orders",
  primary_key_property: "id",
  properties: [
    {
      id: "eeee1111-0001-4001-8001-000000000001",
      key: "title",
      title: "제목",
      field_type: "text",
      config: { max_len: 200 },
      backing_column: "title",
      required: true,
      in_property_policy: false,
    },
    {
      id: "eeee1111-0001-4001-8001-000000000002",
      key: "cost",
      title: "예상 비용",
      field_type: "money",
      config: {},
      backing_column: null,
      required: false,
      in_property_policy: true,
    },
  ],
  links: [
    {
      id: LINK_TYPE_ID,
      stable_key: "wo_memo",
      title: "점검 메모",
      reverse_title: null,
      to_object_type_id: MEMO_TYPE_ID,
      cardinality: "one_many",
      traversable: true,
    },
  ],
  actions: [
    {
      id: "ffff1111-0001-4001-8001-000000000001",
      stable_key: "reassign",
      title: "재배정",
      params_schema: {},
      edits: {},
      submission_criteria: {},
      side_effects: {},
      dispatch: "projected_usecase",
      dispatch_target: null,
      control_points: {},
    },
  ],
  analytics: [],
};

const memoDetail = {
  object_type: memoSummary,
  title_property_key: null,
  backing_table: null,
  primary_key_property: null,
  properties: [
    {
      id: "eeee2222-0001-4001-8001-000000000001",
      key: "body",
      title: "내용",
      field_type: "text",
      config: {},
      backing_column: null,
      required: true,
      in_property_policy: false,
    },
  ],
  links: [],
  actions: [],
  analytics: [],
};

const woInstanceState = {
  instance: {
    id: WO_INSTANCE_ID,
    object_type_id: WO_TYPE_ID,
    title: "4호기 유압 점검",
    current_revision_id: "9999aaaa-0002-4002-8002-000000000002",
    lifecycle_state: "active",
  },
  revision: {
    id: "9999aaaa-0002-4002-8002-000000000002",
    instance_id: WO_INSTANCE_ID,
    version: 2,
    attributes: { title: "4호기 유압 점검" },
    valid_from: "2026-07-08T05:20:00Z",
    valid_to: null,
    action_type_id: null,
    actor: ACTOR_ID,
    reason: null,
    prev_hash: ROW_HASH_V1,
    row_hash: ROW_HASH_V2,
  },
};

const woHistory = [
  {
    id: "9999aaaa-0001-4001-8001-000000000001",
    instance_id: WO_INSTANCE_ID,
    version: 1,
    attributes: { title: "4호기 유압 점검" },
    valid_from: "2026-07-07T00:03:00Z",
    valid_to: "2026-07-08T05:20:00Z",
    action_type_id: null,
    actor: ACTOR_ID,
    reason: null,
    prev_hash: GENESIS_HASH,
    row_hash: ROW_HASH_V1,
  },
  woInstanceState.revision,
];

const woTraversal = {
  root: WO_INSTANCE_ID,
  nodes: [
    {
      instance_id: WO_INSTANCE_ID,
      object_type_id: WO_TYPE_ID,
      title: "4호기 유압 점검",
      lifecycle_state: "active",
      depth: 0,
    },
    {
      instance_id: MEMO_INSTANCE_ID,
      object_type_id: MEMO_TYPE_ID,
      title: "유압 점검 메모",
      lifecycle_state: "active",
      depth: 1,
    },
  ],
  edges: [
    {
      id: EDGE_ID,
      link_type_id: LINK_TYPE_ID,
      from_instance_id: WO_INSTANCE_ID,
      to_instance_id: MEMO_INSTANCE_ID,
    },
  ],
};

function registryHandlers() {
  return [
    http.get("*/api/v1/ontology/object-types", () =>
      HttpResponse.json([woSummary, memoSummary]),
    ),
    http.get("*/api/v1/ontology/object-types/:key", ({ params }) =>
      params.key === "work_order"
        ? HttpResponse.json(woDetail)
        : HttpResponse.json(memoDetail),
    ),
    http.get("*/api/v1/ontology/instances", ({ request }) => {
      const type = new URL(request.url).searchParams.get("type");
      return HttpResponse.json(type === WO_TYPE_ID ? [woInstanceState] : []);
    }),
    http.get("*/api/v1/ontology/instances/:id", () =>
      HttpResponse.json(woInstanceState),
    ),
    http.get("*/api/v1/ontology/instances/:id/history", () =>
      HttpResponse.json(woHistory),
    ),
    http.get("*/api/v1/ontology/instances/:id/traverse", () =>
      HttpResponse.json(woTraversal),
    ),
  ];
}

const session: AuthSession = {
  access_token: "ontology-token",
  user_id: "admin-1",
  roles: ["ADMIN"],
  branches: [],
};

function makeAuthContext(): AuthContextValue {
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(session.access_token),
  };
}

function renderPage() {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <WindowManagerProvider>
        <OntologyPage />
      </WindowManagerProvider>
    </AuthContext.Provider>,
  );
}

async function findTypeRow() {
  return screen.findByRole("button", { name: "work_order 작업지시 타입 편집" });
}

describe("OntologyPage (REST-wired ontology workspace)", () => {
  it("loads the type registry and detail from GET /ontology/object-types(+/{key})", async () => {
    server.use(...registryHandlers());
    renderPage();

    const row = await findTypeRow();
    expect(within(row).getByText("게시됨")).toBeVisible();
    expect(within(row).getByText("v2")).toBeVisible();
    expect(within(row).getByText("개체 1")).toBeVisible();

    const panel = screen.getByRole("article", { name: "작업지시" });
    expect(within(panel).getByText("예상 비용")).toBeVisible();
    // in_property_policy from the wire payload renders the policy chip.
    expect(within(panel).getByText("속성 정책")).toBeVisible();

    fireEvent.click(within(panel).getByRole("tab", { name: "관계" }));
    const linkRow = within(panel).getByText("점검 메모").closest("li");
    expect(linkRow).not.toBeNull();
    // link target resolved by to_object_type_id → the memo type's stable key.
    expect(within(linkRow as HTMLElement).getByText("safety_memo")).toBeVisible();
  });

  it("stages a v+1 revision via PUT /ontology/object-types/{key} with a faithful draft", async () => {
    let staged: CreateObjectTypeDraft | undefined;
    server.use(
      ...registryHandlers(),
      http.put("*/api/v1/ontology/object-types/:key", async ({ request, params }) => {
        expect(params.key).toBe("work_order");
        staged = (await request.json()) as CreateObjectTypeDraft;
        return HttpResponse.json(
          { ...woSummary, schema_version: 3 },
          { status: 201 },
        );
      }),
    );
    renderPage();
    await findTypeRow();

    const panel = screen.getByRole("article", { name: "작업지시" });
    fireEvent.change(within(panel).getByLabelText("속성 이름"), {
      target: { value: "예산 코드" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "속성 추가" }));

    const banner = within(panel).getByRole("status", { name: "개정 대기" });
    fireEvent.click(within(banner).getByRole("button", { name: "적용 승인" }));

    await waitFor(() => {
      expect(staged).toBeDefined();
    });
    // Server-known children round-trip verbatim (config untouched); the added
    // property is appended from the editor form.
    expect(staged?.stable_key).toBe("work_order");
    expect(staged?.backing_kind).toBe("projected");
    expect(staged?.backing_table).toBe("work_orders");
    expect(staged?.primary_key_property).toBe("id");
    const properties = staged?.properties as Record<string, unknown>[];
    expect(properties).toHaveLength(3);
    expect(properties[0]).toMatchObject({ key: "title", config: { max_len: 200 } });
    expect(properties[2]).toMatchObject({ title: "예산 코드", field_type: "text" });
    const links = staged?.links as Record<string, unknown>[];
    expect(links[0]).toMatchObject({
      stable_key: "wo_memo",
      to_object_type_id: MEMO_TYPE_ID,
    });

    // Committed → the registry reloads from the server.
    await waitFor(() => {
      expect(
        screen.queryByRole("status", { name: "개정 대기" }),
      ).not.toBeInTheDocument();
    });
  });

  it("opens an instance card from GET /instances/{id} with API-derived hash verification", async () => {
    server.use(...registryHandlers());
    renderPage();
    await findTypeRow();

    const panel = screen.getByRole("article", { name: "작업지시" });
    fireEvent.click(within(panel).getByRole("tab", { name: "인스턴스" }));
    // Instance code is the API id's short handle — no fabricated WO- code.
    fireEvent.click(
      within(panel).getByRole("button", { name: "AAAA1111 개체 카드 열기" }),
    );

    const card = await screen.findByRole("region", { name: "4호기 유압 점검" });
    expect(within(card).getByText("AAAA1111")).toBeVisible();
    // Both revisions verify against the fixity chain in the history payload.
    const verified = within(card).getAllByText(
      ko.console.objectcard.history.hashVerified,
    );
    expect(verified).toHaveLength(2);
  });

  it("flags a broken fixity chain from the history payload", async () => {
    server.use(
      // First match wins: the corrupt-chain history shadows the default one.
      http.get("*/api/v1/ontology/instances/:id/history", () =>
        HttpResponse.json([
          woHistory[0],
          { ...woHistory[1], prev_hash: "f".repeat(64) },
        ]),
      ),
      ...registryHandlers(),
    );
    renderPage();
    await findTypeRow();

    const panel = screen.getByRole("article", { name: "작업지시" });
    fireEvent.click(within(panel).getByRole("tab", { name: "인스턴스" }));
    fireEvent.click(
      within(panel).getByRole("button", { name: "AAAA1111 개체 카드 열기" }),
    );

    const card = await screen.findByRole("region", { name: "4호기 유압 점검" });
    expect(
      within(card).getByText(ko.console.objectcard.history.hashUnverified),
    ).toBeVisible();
    expect(
      within(card).getByText(ko.console.objectcard.history.hashVerified),
    ).toBeVisible();
  });

  it("drives the graph tab from GET /instances/{id}/traverse", async () => {
    server.use(...registryHandlers());
    renderPage();
    await findTypeRow();

    fireEvent.click(screen.getByRole("tab", { name: "그래프·탐색" }));

    const graph = await screen.findByRole("region", { name: "객체 관계 그래프" });
    expect(within(graph).getByText("4호기 유압 점검")).toBeVisible();
    expect(within(graph).getByText("유압 점검 메모")).toBeVisible();
    // Registry rail cards come from the object-type list (stable_key handle).
    const typeCard = screen.getByLabelText("work_order 타입 카드");
    expect(within(typeCard).getByText("작업지시")).toBeVisible();
    expect(within(typeCard).getByText("개체 1개")).toBeVisible();
    // Relation label resolves through the registry link-type title.
    expect(screen.getAllByText("점검 메모").length).toBeGreaterThan(0);
  });

  it("shows the error state with retry when the registry read fails", async () => {
    server.use(
      http.get("*/api/v1/ontology/object-types", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderPage();

    expect(await screen.findByText(ko.page.loadFailed)).toBeVisible();

    server.use(...registryHandlers());
    fireEvent.click(screen.getByRole("button", { name: ko.page.retry }));
    expect(await findTypeRow()).toBeVisible();
  });
});
