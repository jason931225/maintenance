import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LeaveRequestView, LeaveRosterEntry } from "../../../api/types";
import { ko } from "../../../i18n/ko";
import type * as authzModule from "../../policy/authz";
import type { AuthzProjection } from "../../policy/authz";
import { LeaveBody } from "./LeaveBody";

const S = ko.console.leave;
const mockUseAuth = vi.fn();
const mockFetchAuthzProjection =
  vi.fn<typeof authzModule.fetchAuthzProjection>();

vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));
vi.mock("../../policy/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof authzModule>();
  return {
    ...actual,
    fetchAuthzProjection: (...args: unknown[]) =>
      mockFetchAuthzProjection(...args),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const roster: LeaveRosterEntry[] = [
  {
    employee_id: "emp-1",
    name: "Kim",
    team: "Ops",
    grant: 20,
    used: 5,
    left: 15,
    tone: "ok",
  },
  {
    employee_id: "emp-2",
    name: "Lee",
    team: "Ops",
    grant: 15,
    used: 14,
    left: 1,
    tone: "promote",
  },
];

function request(overrides: Partial<LeaveRequestView> = {}): LeaveRequestView {
  return {
    id: "req-1",
    branch_id: "branch-1",
    requester_user_id: "self-user",
    subject_employee_id: "emp-1",
    leave_type: "annual",
    days: null,
    charge_units: null,
    charge_state: "review_required",
    charge_review_reasons: ["missing_calendar"],
    request_version: 0,
    charge_version: 0,
    start_date: "2026-07-20",
    end_date: "2026-07-20",
    reason: "Personal",
    status: "pending",
    decided_by: null,
    decided_at: null,
    created_at: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

function projection(
  read = false,
  manageScope: "none" | "all" | string[] = "none",
): AuthzProjection {
  const capabilities: AuthzProjection["capabilities"] = [];
  if (read)
    capabilities.push({
      feature: "employee_directory_read",
      permission: "allow",
      branchScope: { kind: "all" },
    });
  if (manageScope !== "none") {
    capabilities.push({
      feature: "employee_directory_manage",
      permission: "allow",
      branchScope:
        manageScope === "all"
          ? { kind: "all" }
          : { kind: "branches", branches: manageScope },
    });
  }
  return {
    source: "authz",
    roles: [],
    branchScope: { kind: "all" },
    capabilities,
  };
}

interface Setup {
  self?: LeaveRequestView[];
  managed?: LeaveRequestView[];
  authz?: Promise<AuthzProjection | undefined> | AuthzProjection | undefined;
  managerFailure?: boolean;
  selfFailure?: unknown;
  onGet?: (path: string, options: unknown) => unknown;
  onPost?: (path: string, options: unknown) => unknown;
  apiName?: string;
  clientUserId?: string;
}

function setup(options: Setup = {}) {
  const GET = vi.fn(async (path: string, requestOptions: unknown) => {
    await Promise.resolve();
    const overridden = options.onGet?.(path, requestOptions);
    if (overridden !== undefined) return overridden;
    if (path === "/api/v1/me/leave") {
      if (options.selfFailure) return { error: options.selfFailure };
      return {
        data: {
          balance: {
            employee_id: "emp-1",
            name: options.apiName ?? "Self",
            accrued_units: "20.000000",
            used_units: "5.000000",
            remaining_units: "15.000000",
          },
          requests: { items: options.self ?? [request()], next_cursor: null },
        },
      };
    }
    if (path === "/api/v1/leave/balances") {
      return options.managerFailure
        ? { error: { error: { message: "managed failed" } } }
        : { data: { items: roster } };
    }
    if (path === "/api/v1/leave/requests") {
      return options.managerFailure
        ? { error: { error: { message: "managed failed" } } }
        : {
            data: {
              items: options.managed ?? [
                request({ requester_user_id: "other-user" }),
              ],
              next_cursor: null,
            },
          };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const POST = vi.fn(async (path: string, postOptions: unknown) => {
    await Promise.resolve();
    const overridden = options.onPost?.(path, postOptions);
    if (overridden !== undefined) return overridden;
    if (path === "/api/v1/leave/requests")
      return { data: request({ id: "created" }) };
    if (path === "/api/v1/leave/requests/{id}/decide") {
      return {
        data: request({
          status: "approved",
          charge_state: "resolved",
          charge_units: "1.000000",
          request_version: 2,
          charge_version: 2,
        }),
      };
    }
    if (path === "/api/v1/leave/requests/{id}/charge-resolution") {
      return {
        data: {
          request_id: "req-1",
          request_version: 1,
          charge_units: "0.400000",
          charge_state: "resolved",
          charge_version: 1,
          server_digest: "digest",
        },
      };
    }
    if (path === "/api/v1/leave/promotions") {
      return {
        data: {
          id: "push",
          kind: "promotion",
          round: 1,
          target_user_id: "other-user",
          inbox_doc_id: "doc",
          ap_submission: "submitted",
        },
      };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  mockUseAuth.mockReturnValue({
    api: { GET, POST },
    session: {
      access_token: "token",
      client_session_incarnation: options.apiName ?? "a",
      user_id: "clientUserId" in options ? options.clientUserId : "self-user",
      org_id: "org-1",
    },
  });
  mockFetchAuthzProjection.mockImplementationOnce(() =>
    Promise.resolve(options.authz),
  );
  return { GET, POST };
}

afterEach(() => {
  mockUseAuth.mockReset();
  mockFetchAuthzProjection.mockReset();
});

describe("LeaveBody authoritative personas", () => {
  it("Member always fetches self and never calls managed endpoints", async () => {
    const { GET } = setup({ authz: projection(false) });
    render(<LeaveBody />);
    expect(
      await screen.findByRole("region", { name: S.self.title }),
    ).toBeVisible();
    expect(GET).toHaveBeenCalledWith("/api/v1/me/leave", {
      params: { query: { limit: 200 } },
    });
    expect(GET.mock.calls.map(([path]) => path)).toEqual(["/api/v1/me/leave"]);
    expect(screen.queryByRole("region", { name: S.ledger.title })).toBeNull();
  });

  it("shows caller-scoped self service when the optional client user id is absent", async () => {
    setup({
      authz: projection(false),
      clientUserId: undefined,
      self: [request({ reason: "Server-scoped self request" })],
    });
    render(<LeaveBody />);

    expect(
      await screen.findByRole("region", { name: S.self.title }),
    ).toBeVisible();
    expect(screen.getByText("Server-scoped self request")).toBeVisible();
    expect(screen.getByRole("button", { name: S.self.submit })).toBeVisible();
  });

  it("loads every self-service keyset page beyond the server cap", async () => {
    setup({
      authz: projection(false),
      onGet: (path, requestOptions) => {
        if (path !== "/api/v1/me/leave") return undefined;
        const cursor = (
          requestOptions as { params: { query: { cursor?: string } } }
        ).params.query.cursor;
        return {
          data: {
            balance: {
              employee_id: "emp-1",
              name: "Self",
              accrued_units: "20.000000",
              used_units: "5.000000",
              remaining_units: "15.000000",
            },
            requests: cursor
              ? {
                  items: [request({ id: "older", reason: "Older page" })],
                  next_cursor: null,
                }
              : {
                  items: [request({ id: "newer", reason: "Newer page" })],
                  next_cursor: "newer",
                },
          },
        };
      },
    });
    render(<LeaveBody />);

    expect(await screen.findByText("Newer page")).toBeVisible();
    expect(await screen.findByText("Older page")).toBeVisible();
  });

  it("fails closed when a self-service page repeats its cursor", async () => {
    const { GET } = setup({
      authz: projection(false),
      onGet: (path) =>
        path === "/api/v1/me/leave"
          ? {
              data: {
                balance: {
                  employee_id: "emp-1",
                  name: "Self",
                  accrued_units: "20.000000",
                  used_units: "5.000000",
                  remaining_units: "15.000000",
                },
                requests: { items: [request()], next_cursor: "repeat" },
              },
            }
          : undefined,
    });
    render(<LeaveBody />);

    expect(await screen.findByText("연차 정보를 불러오지 못했습니다.")).toBeVisible();
    expect(
      GET.mock.calls.filter(([path]) => path === "/api/v1/me/leave"),
    ).toHaveLength(2);
  });

  it("Executive gets managed reads but no decide or promotion actions", async () => {
    const { GET } = setup({
      authz: projection(true),
      managed: [
        request({
          requester_user_id: "other-user",
          charge_state: "resolved",
          charge_units: "1.000000",
        }),
      ],
    });
    render(<LeaveBody />);
    expect(
      await screen.findByRole("region", { name: S.ledger.title }),
    ).toBeVisible();
    await waitFor(() => {
      expect(GET).toHaveBeenCalledWith(
        "/api/v1/leave/requests",
        expect.anything(),
      );
    });
    const queue = screen.getByRole("region", { name: S.queue.title });
    expect(within(queue).queryByRole("button")).toBeNull();
  });

  it("loads every managed keyset page beyond the server cap", async () => {
    setup({
      authz: projection(true),
      onGet: (path, requestOptions) => {
        if (path !== "/api/v1/leave/requests") return undefined;
        const cursor = (
          requestOptions as { params: { query: { cursor?: string } } }
        ).params.query.cursor;
        return {
          data: cursor
            ? {
                items: [
                  request({
                    id: "managed-older",
                    reason: "Managed older page",
                    requester_user_id: "other-user",
                  }),
                ],
                next_cursor: null,
              }
            : {
                items: [
                  request({
                    id: "managed-newer",
                    reason: "Managed newer page",
                    requester_user_id: "other-user",
                  }),
                ],
                next_cursor: "managed-newer",
              },
        };
      },
    });
    render(<LeaveBody />);

    expect(await screen.findByText("Managed newer page")).toBeVisible();
    expect(await screen.findByText("Managed older page")).toBeVisible();
  });

  it("authz loading and failure remain fail closed while self-service stays available", async () => {
    const authz = deferred<AuthzProjection | undefined>();
    setup({ authz: authz.promise });
    render(<LeaveBody />);
    expect(
      await screen.findByRole("region", { name: S.self.title }),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: S.ledger.title })).toBeNull();
    authz.resolve(undefined);
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: S.ledger.title })).toBeNull();
    });
  });

  it("managed-load failure preserves the self view and exposes a retryable partial failure", async () => {
    setup({ authz: projection(true), managerFailure: true });
    render(<LeaveBody />);
    expect(
      await screen.findByRole("region", { name: S.self.title }),
    ).toBeVisible();
    expect(
      await screen.findByText(
        "Your leave data is available, but managed leave data could not be loaded.",
      ),
    ).toBeVisible();
  });

  it("surfaces an honest unlinked/self failure instead of mounting managed data", async () => {
    setup({
      authz: projection(true, "all"),
      clientUserId: undefined,
      selfFailure: {
        error: { message: "Employee link or home branch is required" },
      },
    });
    render(<LeaveBody />);
    expect(
      await screen.findByText("Employee link or home branch is required"),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: S.ledger.title })).toBeNull();
  });

  it("ignores a retired authority's deferred self load", async () => {
    const stale = deferred<unknown>();
    setup({
      authz: projection(false),
      onGet: (path) =>
        path === "/api/v1/me/leave" ? stale.promise : undefined,
      apiName: "A",
    });
    const view = render(<LeaveBody />);
    setup({
      authz: projection(false),
      self: [request({ id: "b", reason: "B authority" })],
      apiName: "B",
    });
    view.rerender(<LeaveBody />);
    expect(await screen.findByText("B authority")).toBeVisible();
    stale.resolve({
      data: {
        balance: {
          employee_id: "emp-1",
          name: "A",
          accrued_units: null,
          used_units: null,
          remaining_units: null,
        },
        requests: {
          items: [request({ id: "a", reason: "A stale" })],
          next_cursor: null,
        },
      },
    });
    await Promise.resolve();
    expect(screen.queryByText("A stale")).toBeNull();
  });

  it("preserves AM and PM create intent and reports missing-home-branch conflict", async () => {
    const { POST } = setup({
      authz: projection(false),
      self: [],
      onPost: (path) =>
        path === "/api/v1/leave/requests"
          ? {
              error: {
                error: { message: "Authoritative home branch review required" },
              },
            }
          : undefined,
    });
    render(<LeaveBody />);
    const self = await screen.findByRole("region", { name: S.self.title });
    fireEvent.change(within(self).getByLabelText(S.self.reasonLabel), {
      target: { value: "half_pm" },
    });
    fireEvent.change(within(self).getByLabelText(S.self.startLabel), {
      target: { value: "2026-08-03" },
    });
    await userEvent.click(
      within(self).getByRole("button", { name: S.self.submit }),
    );
    expect(
      await screen.findByText("Authoritative home branch review required"),
    ).toBeVisible();
    expect(POST).toHaveBeenCalledWith("/api/v1/leave/requests", {
      body: expect.objectContaining({
        idempotency_key: expect.any(String),
        leave_type: "half_day",
        partial_day_period: "pm",
        start_date: "2026-08-03",
        end_date: "2026-08-03",
        reason: S.reasons.half_pm,
      }),
    });
  });

  it("reuses one submission key when retrying an unknown create outcome", async () => {
    const { POST } = setup({
      authz: projection(false),
      self: [],
      onPost: (path) =>
        path === "/api/v1/leave/requests"
          ? { error: { error: { message: "connection lost" } } }
          : undefined,
    });
    render(<LeaveBody />);
    const self = await screen.findByRole("region", { name: S.self.title });
    fireEvent.change(within(self).getByLabelText(S.self.reasonLabel), {
      target: { value: "annual" },
    });
    fireEvent.change(within(self).getByLabelText(S.self.startLabel), {
      target: { value: "2026-08-03" },
    });
    fireEvent.change(within(self).getByLabelText(S.self.endLabel), {
      target: { value: "2026-08-03" },
    });
    const submit = within(self).getByRole("button", { name: S.self.submit });

    await userEvent.click(submit);
    await screen.findByText("connection lost");
    await userEvent.click(submit);
    await waitFor(() => {
      expect(
        POST.mock.calls.filter(([path]) => path === "/api/v1/leave/requests"),
      ).toHaveLength(2);
    });

    const createBodies = POST.mock.calls
      .filter(([path]) => path === "/api/v1/leave/requests")
      .map(([, options]) =>
        (options as { body: { idempotency_key: string } }).body
          .idempotency_key,
      );
    expect(createBodies[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(createBodies[1]).toBe(createBodies[0]);
  });

  it("Admin actions are branch-scoped and decide carries the exact request version", async () => {
    const { POST } = setup({
      authz: projection(true, ["branch-1"]),
      self: [],
      managed: [
        request({
          id: "in",
          branch_id: "branch-1",
          requester_user_id: "other-user",
          charge_state: "resolved",
          charge_units: "0.125000",
          request_version: 12,
          charge_version: 8,
        }),
        request({
          id: "out",
          branch_id: "branch-2",
          requester_user_id: "outside",
          charge_state: "resolved",
          charge_units: "0.500000",
          request_version: 13,
          charge_version: 9,
        }),
      ],
    });
    render(<LeaveBody />);
    const queue = await screen.findByRole("region", { name: S.queue.title });
    const approve = await within(queue).findByRole("button", {
      name: S.queue.decideAria(S.queue.approve, "Kim"),
    });
    await userEvent.click(approve);
    expect(POST).toHaveBeenCalledWith("/api/v1/leave/requests/{id}/decide", {
      params: { path: { id: "in" } },
      body: { expected_version: 12, decision: "approve", comment: undefined },
    });
  });

  it("uses the advanced request version when deciding after charge resolution", async () => {
    const { POST } = setup({
      authz: projection(true, ["branch-1"]),
      self: [],
      managed: [
        request({
          requester_user_id: "other-user",
          request_version: 7,
          charge_version: 3,
        }),
      ],
      onPost: (path) => {
        if (path === "/api/v1/leave/requests/{id}/charge-resolution") {
          return {
            data: {
              request_id: "req-1",
              request_version: 8,
              charge_units: "0.400000",
              charge_state: "resolved",
              charge_version: 4,
              server_digest: "digest",
              resolution_origin: "manual",
              resolved_by: "manager-user",
            },
          };
        }
        return undefined;
      },
    });
    render(<LeaveBody />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Open manual review: Kim" }),
    );
    await userEvent.type(screen.getByLabelText("Scheduled minutes"), "480");
    await userEvent.type(
      screen.getByLabelText("Exact charge units"),
      "0.400000",
    );
    await userEvent.type(
      screen.getByLabelText("Calendar source kind"),
      "work_calendar",
    );
    await userEvent.type(
      screen.getByLabelText("Calendar source reference"),
      "emp-1",
    );
    await userEvent.type(
      screen.getByLabelText("Calendar source revision"),
      "cal-v1",
    );
    await userEvent.type(
      screen.getByLabelText("Policy source kind"),
      "leave_policy",
    );
    await userEvent.type(
      screen.getByLabelText("Policy source reference"),
      "annual",
    );
    await userEvent.type(
      screen.getByLabelText("Policy source revision"),
      "pol-v1",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Resolve charge" }),
    );

    expect(POST).toHaveBeenCalledWith(
      "/api/v1/leave/requests/{id}/charge-resolution",
      expect.objectContaining({
        body: expect.objectContaining({ expected_version: 7 }),
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: S.queue.decideAria(S.queue.approve, "Kim"),
      }),
    );
    expect(POST).toHaveBeenCalledWith("/api/v1/leave/requests/{id}/decide", {
      params: { path: { id: "req-1" } },
      body: { expected_version: 8, decision: "approve", comment: undefined },
    });
  });
});
