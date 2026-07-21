import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { StrictMode } from "react";
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

import { GENESIS_HASH, type CreateObjectTypeDraft } from "../api/ontology";
import { clearAuthorizeBulkCache } from "../api/authorizeBulk";
import { createConsoleApiClient } from "../api/client";
import { WindowManagerProvider } from "../console/window";
import {
  AuthContext,
  type AuthContextValue,
  type AuthSession,
} from "../context/auth";
import { ko } from "../i18n/ko";
import { allowAllBulkAuthorize } from "../test/policyGateMock";
import { OntologyPage } from "./OntologyPage";

// OntologyPage renders behind BulkPolicyGateProvider (POST .../policy/authorize/bulk);
// registered as a base handler so it survives resetHandlers() between tests.
const server = setupServer(allowAllBulkAuthorize());

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
  clearAuthorizeBulkCache();
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
  key_write_revision: 2,
  key_write_etag: '"ont-object-type-key:11111111111111111111111111111111:r2"',
};

const memoSummary = {
  id: MEMO_TYPE_ID,
  stable_key: "safety_memo",
  title: "안전 점검 메모",
  backing_kind: "instance",
  schema_version: 1,
  lifecycle_state: "draft",
  key_write_revision: 1,
  key_write_etag: '"ont-object-type-key:22222222222222222222222222222222:r1"',
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

function successorSummary(summary: typeof woSummary): typeof woSummary {
  const revision = summary.key_write_revision + 1;
  return {
    ...summary,
    key_write_revision: revision,
    key_write_etag: summary.key_write_etag.replace(
      /:r\d+"$/,
      `:r${String(revision)}"`,
    ),
  };
}

function stagedResponse(summary: typeof woSummary) {
  const successor = successorSummary(summary);
  return HttpResponse.json(successor, {
    status: 201,
    headers: { ETag: successor.key_write_etag },
  });
}

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
  client_session_incarnation: "ontology-session-default",
  user_id: "admin-1",
  org_id: "11111111-1111-4111-8111-111111111111",
  roles: ["ADMIN"],
  branches: [],
};

function authoritySession(label: "A" | "B"): AuthSession {
  const suffix = label.toLowerCase();
  return {
    ...session,
    access_token: `token-${suffix}`,
    client_session_incarnation: `ontology-session-${suffix}`,
    org_id: `tenant-${suffix}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushTasks(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeAuthContext(
  activeSession: AuthSession = session,
): AuthContextValue {
  return {
    session: activeSession,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(activeSession.access_token),
  };
}

function pageTree(auth: AuthContextValue) {
  return (
    <AuthContext.Provider value={auth}>
      <WindowManagerProvider>
        <OntologyPage />
      </WindowManagerProvider>
    </AuthContext.Provider>
  );
}

function renderPage(auth: AuthContextValue = makeAuthContext()) {
  return render(pageTree(auth));
}

function authorityRegistry(label: "A" | "B") {
  const summary = { ...woSummary, title: `${label} 작업지시` };
  const validator =
    label === "A"
      ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  summary.key_write_etag = `"ont-object-type-key:${validator}:r${String(summary.key_write_revision)}"`;
  const detail = { ...woDetail, object_type: summary };
  const instance = {
    ...woInstanceState,
    instance: { ...woInstanceState.instance, title: `${label} 그래프` },
  };
  const traversal = {
    ...woTraversal,
    nodes: woTraversal.nodes.map((node, index) => ({
      ...node,
      title: index === 0 ? `${label} 그래프` : node.title,
    })),
  };
  return { summary, detail, instance, traversal };
}

function authoritySwitchRegistry(label: "A" | "B") {
  const registry = authorityRegistry(label);
  const summary = {
    ...registry.summary,
    id:
      label === "A"
        ? "11111111-1111-4111-8111-11111111111a"
        : "11111111-1111-4111-8111-11111111111b",
    stable_key: `${label.toLowerCase()}_work_order`,
  };
  return {
    ...registry,
    summary,
    detail: { ...registry.detail, object_type: summary },
    instance: {
      ...registry.instance,
      instance: { ...registry.instance.instance, object_type_id: summary.id },
    },
  };
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
    expect(
      within(linkRow as HTMLElement).getByText("safety_memo"),
    ).toBeVisible();
  });

  it("stages a v+1 revision via PUT /ontology/object-types/{key} with a faithful draft", async () => {
    let staged: CreateObjectTypeDraft | undefined;
    server.use(
      ...registryHandlers(),
      http.put(
        "*/api/v1/ontology/object-types/:key",
        async ({ request, params }) => {
          expect(params.key).toBe("work_order");
          staged = (await request.json()) as CreateObjectTypeDraft;
          return stagedResponse({ ...woSummary, schema_version: 3 });
        },
      ),
    );
    renderPage();
    await findTypeRow();

    const panel = screen.getByRole("article", { name: "작업지시" });
    // The editor form (and its add-property control) is gated behind
    // BulkPolicyGateProvider, whose decision resolves after mount — find
    // (async) rather than get (sync).
    fireEvent.change(await within(panel).findByLabelText("속성 이름"), {
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
    expect(properties[0]).toMatchObject({
      key: "title",
      config: { max_len: 200 },
    });
    expect(properties[2]).toMatchObject({
      title: "예산 코드",
      field_type: "text",
    });
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
    // The instance-open control is gated behind BulkPolicyGateProvider, whose
    // decision resolves after mount — find (async) rather than get (sync).
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: "AAAA1111 개체 카드 열기",
      }),
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
    // The instance-open control is gated behind BulkPolicyGateProvider, whose
    // decision resolves after mount — find (async) rather than get (sync).
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: "AAAA1111 개체 카드 열기",
      }),
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

    const graph = await screen.findByRole("region", {
      name: "객체 관계 그래프",
    });
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
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    renderPage();

    expect(await screen.findByText(ko.page.loadFailed)).toBeVisible();

    server.use(...registryHandlers());
    fireEvent.click(screen.getByRole("button", { name: ko.page.retry }));
    expect(await findTypeRow()).toBeVisible();
  });

  it("masks A immediately on an authority rerender and only lets loaded B persist", async () => {
    const a = authoritySwitchRegistry("A");
    const b = authoritySwitchRegistry("B");
    const putRequests: Array<{
      authorization: string | null;
      key: string;
      body: CreateObjectTypeDraft;
    }> = [];
    server.use(
      http.get("*/api/v1/ontology/object-types", ({ request }) =>
        HttpResponse.json([
          request.headers.get("authorization") === "Bearer token-a"
            ? a.summary
            : b.summary,
        ]),
      ),
      http.get("*/api/v1/ontology/object-types/:key", ({ request }) =>
        HttpResponse.json(
          request.headers.get("authorization") === "Bearer token-a"
            ? a.detail
            : b.detail,
        ),
      ),
      http.get("*/api/v1/ontology/instances", ({ request }) =>
        HttpResponse.json([
          request.headers.get("authorization") === "Bearer token-a"
            ? a.instance
            : b.instance,
        ]),
      ),
      http.get("*/api/v1/ontology/instances/:id/traverse", ({ request }) =>
        HttpResponse.json(
          request.headers.get("authorization") === "Bearer token-a"
            ? a.traversal
            : b.traversal,
        ),
      ),
      http.put(
        "*/api/v1/ontology/object-types/:key",
        async ({ request, params }) => {
          putRequests.push({
            authorization: request.headers.get("authorization"),
            key: String(params.key),
            body: (await request.json()) as CreateObjectTypeDraft,
          });
          return stagedResponse(b.summary);
        },
      ),
    );
    const authA = makeAuthContext(authoritySession("A"));
    const authB = makeAuthContext(authoritySession("B"));
    const view = render(<StrictMode>{pageTree(authA)}</StrictMode>);
    const staleAPanel = await screen.findByRole("article", {
      name: "A 작업지시",
    });
    const staleAInput = await within(staleAPanel).findByLabelText("속성 이름");
    const staleAAdd = within(staleAPanel).getByRole("button", {
      name: "속성 추가",
    });

    view.rerender(<StrictMode>{pageTree(authB)}</StrictMode>);
    fireEvent.change(staleAInput, { target: { value: "A 유출" } });
    fireEvent.click(staleAAdd);
    const staleApproval = within(staleAPanel).queryByRole("status", {
      name: "개정 대기",
    });
    if (staleApproval) {
      fireEvent.click(
        within(staleApproval).getByRole("button", { name: "적용 승인" }),
      );
    }

    expect(
      screen.queryByRole("article", { name: "A 작업지시" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("속성 이름")).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: ko.page.loading }),
    ).toBeInTheDocument();
    expect(putRequests).toEqual([]);

    const bPanel = await screen.findByRole("article", { name: "B 작업지시" });
    fireEvent.change(await within(bPanel).findByLabelText("속성 이름"), {
      target: { value: "B 저장" },
    });
    fireEvent.click(within(bPanel).getByRole("button", { name: "속성 추가" }));
    fireEvent.click(
      within(
        within(bPanel).getByRole("status", { name: "개정 대기" }),
      ).getByRole("button", {
        name: "적용 승인",
      }),
    );
    await waitFor(() => {
      expect(
        putRequests.some(
          ({ authorization, key }) =>
            authorization === "Bearer token-b" && key === "b_work_order",
        ),
      ).toBe(true);
    });
    expect(
      putRequests.some(
        ({ authorization, key }) =>
          authorization === "Bearer token-b" && key === "a_work_order",
      ),
    ).toBe(false);
    const bRequest = putRequests.find(
      ({ authorization, key }) =>
        authorization === "Bearer token-b" && key === "b_work_order",
    );
    expect(bRequest?.body.properties).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "B 저장" })]),
    );
    expect(bRequest?.body.properties).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "A 유출" })]),
    );
  });

  it("keeps B registry and graph when A's deferred read resolves last", async () => {
    const aGate = deferred<undefined>();
    const aTraversalRequests = vi.fn();
    const a = authorityRegistry("A");
    const b = authorityRegistry("B");
    server.use(
      http.get("*/api/v1/ontology/object-types", async ({ request }) => {
        if (request.headers.get("authorization") === "Bearer token-a") {
          await aGate.promise;
          return HttpResponse.json([a.summary]);
        }
        return HttpResponse.json([b.summary]);
      }),
      http.get("*/api/v1/ontology/object-types/:key", ({ request }) =>
        HttpResponse.json(
          request.headers.get("authorization") === "Bearer token-a"
            ? a.detail
            : b.detail,
        ),
      ),
      http.get("*/api/v1/ontology/instances", ({ request }) =>
        HttpResponse.json(
          request.headers.get("authorization") === "Bearer token-a"
            ? [a.instance]
            : [b.instance],
        ),
      ),
      http.get("*/api/v1/ontology/instances/:id/traverse", ({ request }) => {
        if (request.headers.get("authorization") === "Bearer token-a") {
          aTraversalRequests();
          return HttpResponse.json(a.traversal);
        }
        return HttpResponse.json(b.traversal);
      }),
    );
    const authA = makeAuthContext(authoritySession("A"));
    const authB = makeAuthContext(authoritySession("B"));
    const view = renderPage(authA);
    await flushTasks();
    view.rerender(pageTree(authB));
    expect((await screen.findAllByText("B 작업지시")).length).toBeGreaterThan(
      0,
    );
    fireEvent.click(screen.getByRole("tab", { name: "그래프·탐색" }));
    expect((await screen.findAllByText("B 그래프")).length).toBeGreaterThan(0);

    aGate.resolve(undefined);
    await flushTasks();
    expect(aTraversalRequests).not.toHaveBeenCalled();
    expect(screen.queryByText("A 작업지시")).not.toBeInTheDocument();
    expect(screen.queryByText("A 그래프")).not.toBeInTheDocument();
    expect(screen.getAllByText("B 그래프").length).toBeGreaterThan(0);
  });

  it("keeps B readable when A's deferred read rejects last", async () => {
    const aGate = deferred<undefined>();
    const aResponseSent = vi.fn();
    const b = authorityRegistry("B");
    server.use(
      http.get("*/api/v1/ontology/object-types", async ({ request }) => {
        if (request.headers.get("authorization") === "Bearer token-a") {
          await aGate.promise;
          aResponseSent();
          return HttpResponse.json(
            { error: { code: "internal", message: "A failed" } },
            { status: 500 },
          );
        }
        return HttpResponse.json([b.summary]);
      }),
      http.get("*/api/v1/ontology/object-types/:key", () =>
        HttpResponse.json(b.detail),
      ),
      http.get("*/api/v1/ontology/instances", () =>
        HttpResponse.json([b.instance]),
      ),
      http.get("*/api/v1/ontology/instances/:id/traverse", () =>
        HttpResponse.json(b.traversal),
      ),
    );
    const authA = makeAuthContext(authoritySession("A"));
    const authB = makeAuthContext(authoritySession("B"));
    const view = renderPage(authA);
    await flushTasks();
    view.rerender(pageTree(authB));
    expect((await screen.findAllByText("B 작업지시")).length).toBeGreaterThan(
      0,
    );

    aGate.resolve(undefined);
    await waitFor(() => {
      expect(aResponseSent).toHaveBeenCalledTimes(1);
    });
    await flushTasks();
    expect(screen.queryByText(ko.page.loadFailed)).not.toBeInTheDocument();
    expect(screen.getAllByText("B 작업지시").length).toBeGreaterThan(0);
  });

  it("prevents deferred A read continuation and writes after unmount", async () => {
    const aGate = deferred<undefined>();
    const detailRequests = vi.fn();
    const a = authorityRegistry("A");
    server.use(
      http.get("*/api/v1/ontology/object-types", async () => {
        await aGate.promise;
        return HttpResponse.json([a.summary]);
      }),
      http.get("*/api/v1/ontology/object-types/:key", () => {
        detailRequests();
        return HttpResponse.json(a.detail);
      }),
      http.get("*/api/v1/ontology/instances", () =>
        HttpResponse.json([a.instance]),
      ),
      http.get("*/api/v1/ontology/instances/:id/traverse", () =>
        HttpResponse.json(a.traversal),
      ),
    );
    const view = renderPage(makeAuthContext(authoritySession("A")));
    await flushTasks();
    view.unmount();
    aGate.resolve(undefined);
    await flushTasks();
    expect(detailRequests).not.toHaveBeenCalled();
  });

  for (const surface of ["manager instance", "graph node"] as const) {
    for (const settlement of ["resolve", "reject"] as const) {
      it(`cancels stale A ${surface} ${settlement} after B is current`, async () => {
        const a = authoritySwitchRegistry("A");
        const b = authoritySwitchRegistry("B");
        const aDetailGate = deferred<undefined>();
        const aDetailStarted = deferred<undefined>();
        server.use(
          http.get("*/api/v1/ontology/object-types", ({ request }) =>
            HttpResponse.json([
              request.headers.get("authorization") === "Bearer token-a"
                ? a.summary
                : b.summary,
            ]),
          ),
          http.get("*/api/v1/ontology/object-types/:key", ({ request }) =>
            HttpResponse.json(
              request.headers.get("authorization") === "Bearer token-a"
                ? a.detail
                : b.detail,
            ),
          ),
          http.get("*/api/v1/ontology/instances", ({ request }) =>
            HttpResponse.json([
              request.headers.get("authorization") === "Bearer token-a"
                ? a.instance
                : b.instance,
            ]),
          ),
          http.get("*/api/v1/ontology/instances/:id", async ({ request }) => {
            if (request.headers.get("authorization") === "Bearer token-a") {
              aDetailStarted.resolve(undefined);
              await aDetailGate.promise;
              if (settlement === "reject") {
                return HttpResponse.json(
                  { error: { code: "internal", message: "A retired" } },
                  { status: 500 },
                );
              }
              return HttpResponse.json(a.instance);
            }
            return HttpResponse.json(b.instance);
          }),
          http.get("*/api/v1/ontology/instances/:id/history", () =>
            HttpResponse.json(woHistory),
          ),
          http.get("*/api/v1/ontology/instances/:id/traverse", ({ request }) =>
            HttpResponse.json(
              request.headers.get("authorization") === "Bearer token-a"
                ? a.traversal
                : b.traversal,
            ),
          ),
        );
        const authA = makeAuthContext(authoritySession("A"));
        const authB = makeAuthContext(authoritySession("B"));
        const view = render(<StrictMode>{pageTree(authA)}</StrictMode>);
        const aPanel = await screen.findByRole("article", {
          name: "A 작업지시",
        });
        if (surface === "manager instance") {
          fireEvent.click(
            within(aPanel).getByRole("tab", { name: "인스턴스" }),
          );
          fireEvent.click(
            await within(aPanel).findByRole("button", {
              name: "AAAA1111 개체 카드 열기",
            }),
          );
        } else {
          fireEvent.click(screen.getByRole("tab", { name: "그래프·탐색" }));
          fireEvent.click(
            await screen.findByRole("button", {
              name: "유압 점검 메모 중심으로 이동",
            }),
          );
        }
        await aDetailStarted.promise;

        view.rerender(<StrictMode>{pageTree(authB)}</StrictMode>);
        if (surface === "manager instance") {
          expect(
            await screen.findByRole("article", { name: "B 작업지시" }),
          ).toBeInTheDocument();
        } else {
          expect(
            (await screen.findAllByText("B 그래프")).length,
          ).toBeGreaterThan(0);
        }
        expect(
          screen.queryByRole("region", { name: "A 그래프" }),
        ).not.toBeInTheDocument();

        await act(async () => {
          aDetailGate.resolve(undefined);
          await aDetailGate.promise;
        });
        await flushTasks();
        expect(
          screen.queryByRole("region", { name: "A 그래프" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("A 작업지시")).not.toBeInTheDocument();
        expect(
          screen.getAllByText(
            surface === "manager instance" ? "B 작업지시" : "B 그래프",
          ).length,
        ).toBeGreaterThan(0);
      });
    }
  }

  it("does not surface A persist feedback after switching to B", async () => {
    const persistGate = deferred<undefined>();
    const a = authorityRegistry("A");
    const b = authorityRegistry("B");
    server.use(
      http.get("*/api/v1/ontology/object-types", ({ request }) =>
        HttpResponse.json([
          request.headers.get("authorization") === "Bearer token-a"
            ? a.summary
            : b.summary,
        ]),
      ),
      http.get("*/api/v1/ontology/object-types/:key", ({ request }) =>
        HttpResponse.json(
          request.headers.get("authorization") === "Bearer token-a"
            ? a.detail
            : b.detail,
        ),
      ),
      http.get("*/api/v1/ontology/instances", ({ request }) =>
        HttpResponse.json([
          request.headers.get("authorization") === "Bearer token-a"
            ? a.instance
            : b.instance,
        ]),
      ),
      http.get("*/api/v1/ontology/instances/:id/traverse", ({ request }) =>
        HttpResponse.json(
          request.headers.get("authorization") === "Bearer token-a"
            ? a.traversal
            : b.traversal,
        ),
      ),
      http.put("*/api/v1/ontology/object-types/:key", async ({ request }) => {
        if (request.headers.get("authorization") === "Bearer token-a") {
          await persistGate.promise;
          return HttpResponse.json(
            { error: { code: "internal", message: "A save failed" } },
            { status: 500 },
          );
        }
        return stagedResponse(b.summary);
      }),
    );
    const authA = makeAuthContext(authoritySession("A"));
    const authB = makeAuthContext(authoritySession("B"));
    const view = renderPage(authA);
    expect((await screen.findAllByText("A 작업지시")).length).toBeGreaterThan(
      0,
    );
    const panel = screen.getByRole("article", { name: "A 작업지시" });
    fireEvent.change(await within(panel).findByLabelText("속성 이름"), {
      target: { value: "A 저장" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "속성 추가" }));
    fireEvent.click(
      within(
        within(panel).getByRole("status", { name: "개정 대기" }),
      ).getByRole("button", {
        name: "적용 승인",
      }),
    );
    view.rerender(pageTree(authB));
    expect((await screen.findAllByText("B 작업지시")).length).toBeGreaterThan(
      0,
    );

    persistGate.resolve(undefined);
    await flushTasks();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByText("B 작업지시").length).toBeGreaterThan(0);
  });
});
