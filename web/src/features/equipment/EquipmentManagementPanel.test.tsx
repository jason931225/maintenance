import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../../AppRouter";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import {
  createRefreshAuthority,
  createRefreshCoordinator,
  setRefreshCallbacks,
} from "../../api/refresh";
import type { RefreshAuthority } from "../../api/refresh";
import type { EquipmentLookupResponse } from "../../api/types";
import { branchId } from "../../test/fixtures";
import {
  EquipmentManagementPanel,
  type EquipmentOwnerOrgOption,
} from "./EquipmentManagementPanel";

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

const equipmentId = "44444444-4444-4444-8444-444444444444";
const newEquipmentId = "99999999-9999-4999-8999-999999999999";

const equipment: EquipmentLookupResponse = {
  id: equipmentId,
  branch_id: branchId,
  equipment_no: "D-25-290",
  management_no: "290",
  model: "GTS25DE",
  status: "rented",
  specification: "좌식",
  ton_text: "2.5T",
  maker: "현대",
  vin: null,
  vehicle_registration_no: null,
  customer: { id: "c1", name: "케이앤엘" },
  site: { id: "s1", name: "본사" },
};

const ownerOrgOptions: EquipmentOwnerOrgOption[] = [
  { id: "org-coss", slug: "coss", name: "코스", groupName: "그룹" },
  { id: "org-knl", slug: "knl", name: "케이앤엘", groupName: "그룹" },
];

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
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
    api,
  };
}

function renderApp(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/equipment/manage"]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function renderGroupAdminEquipmentPanel(
  groupAdminRefreshAuthority?: RefreshAuthority,
) {
  function Harness() {
    const [selectedOwnerOrgId, setSelectedOwnerOrgId] = useState("org-coss");
    return (
      <EquipmentManagementPanel
        api={createConsoleApiClient("coss-source-token")}
        results={[equipment]}
        onMutated={() => {}}
        ownerOrgOptions={ownerOrgOptions}
        ownerSelectionRequired
        selectedOwnerOrgId={selectedOwnerOrgId}
        onSelectedOwnerOrgIdChange={setSelectedOwnerOrgId}
        activeOrgId="org-coss"
        groupAdminSourceToken="coss-source-token"
        groupAdminRefreshAuthority={groupAdminRefreshAuthority}
      />
    );
  }

  return render(<Harness />);
}

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "admin-1",
  roles: ["ADMIN"],
  branches: [branchId],
};

const groupAdminSourceSession: AuthSession = {
  access_token: "group-source-token",
  user_id: "group-admin-1",
  roles: ["MEMBER"],
  group_roles: ["GROUP_ADMIN"],
  org_id: "org-coss",
  branches: [branchId],
};

const delegatedCossSession: AuthSession = {
  access_token: "coss-context-token",
  user_id: "group-admin-1",
  roles: ["ADMIN"],
  group_roles: ["GROUP_ADMIN"],
  org_id: "org-coss",
  branches: [branchId],
};

const mechanicSession: AuthSession = {
  access_token: "m",
  user_id: "mech-1",
  roles: ["MECHANIC"],
  branches: [branchId],
};

function searchHandlers() {
  return [
    http.get("*/api/v1/equipment", () =>
      HttpResponse.json({ items: [equipment], limit: 5 }),
    ),
    http.get("*/api/v1/equipment/lookup", () => HttpResponse.json(equipment)),
    // The /equipment page mounts the admin SiteGeographyPanel, which loads the
    // dispatch-map site aggregation on render; stub it so the request never
    // falls through to the real network.
    http.get("*/api/v1/equipment-by-location", () =>
      HttpResponse.json({ items: [], total: 0 }),
    ),
  ];
}

async function typeSearch(user: ReturnType<typeof userEvent.setup>) {
  // Driving the management panel requires a search to populate the row list.
  await user.type(await screen.findByLabelText("호기", { exact: true }), "290");
}

describe("EquipmentManagementPanel", () => {
  it("creates a new equipment row", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      ...searchHandlers(),
      http.post("*/api/v1/equipment", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json({ id: newEquipmentId }, { status: 201 });
      }),
    );

    renderApp(makeAuthContext(adminSession));

    await user.click(await screen.findByRole("button", { name: "장비 등록" }));

    await user.type(screen.getByLabelText("호기 번호"), "D-25-300");
    await user.type(screen.getByLabelText("고객명"), "신규고객");
    await user.type(screen.getByLabelText("현장명"), "신규현장");
    await user.type(screen.getByLabelText("규격"), "입식");
    await user.type(screen.getByLabelText("톤수"), "3.0T");

    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
          equipment_no: "D-25-300",
          customer_name: "신규고객",
          site_name: "신규현장",
          status: "rented",
          specification: "입식",
          ton_text: "3.0T",
        }),
      );
    });
    expect(await screen.findByText("장비를 등록했습니다.")).toBeVisible();
    vi.useRealTimers();
  });

  it("creates under the selected group subsidiary after legal ownership sign-off", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    const contextStarted = vi.fn();
    const contextExited = vi.fn();
    server.use(
      http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
        contextStarted({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({
          access_token: "knl-context-token",
          token_type: "Bearer",
          acting_org_id: "org-knl",
          acting_org_name: "케이앤엘",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2026-06-29T00:00:00Z",
        });
      }),
      http.post("*/api/v1/equipment", async ({ request }) => {
        created({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({ id: newEquipmentId }, { status: 201 });
      }),
      http.post("*/api/v1/group-admin/tenant-context/exit", async ({ request }) => {
        contextExited({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderGroupAdminEquipmentPanel();

    await user.click(screen.getByRole("button", { name: "장비 등록" }));
    await user.selectOptions(screen.getByLabelText("소유 법인"), "org-knl");
    await user.click(
      screen.getByLabelText(/소유 법인, 등록 권한, 회계·계약상 근거/),
    );
    await user.type(screen.getByLabelText("호기 번호"), "D-25-300");
    await user.type(screen.getByLabelText("고객명"), "신규고객");
    await user.type(screen.getByLabelText("현장명"), "신규현장");
    await user.type(screen.getByLabelText("규격"), "입식");
    await user.type(screen.getByLabelText("톤수"), "3.0T");

    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(contextStarted).toHaveBeenCalledWith({
        authorization: "Bearer coss-source-token",
        body: { org_id: "org-knl" },
      });
      expect(created).toHaveBeenCalledWith({
        authorization: "Bearer knl-context-token",
        body: expect.objectContaining({
          equipment_no: "D-25-300",
          customer_name: "신규고객",
          site_name: "신규현장",
        }),
      });
      expect(contextExited).toHaveBeenCalledWith({
        authorization: "Bearer coss-source-token",
        body: { org_id: "org-knl" },
      });
    });
  });

  it("keeps a minted delegated equipment client non-refreshable", async () => {
    const user = userEvent.setup();
    const authority = createRefreshAuthority(
      createRefreshCoordinator(),
      "equipment-source-incarnation",
    );
    const refresh = vi.fn(() =>
      Promise.resolve({ access_token: "fresh-source-token" }),
    );
    setRefreshCallbacks(authority, refresh, () => {});
    const delegatedRequests = vi.fn();
    server.use(
      http.post("*/api/v1/group-admin/tenant-context", () =>
        HttpResponse.json({
          access_token: "knl-context-token",
          token_type: "Bearer",
          acting_org_id: "org-knl",
          acting_org_name: "케이앤엘",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2026-06-29T00:00:00Z",
        }),
      ),
      http.post("*/api/v1/equipment", ({ request }) => {
        delegatedRequests(request.headers.get("authorization"));
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
      http.post("*/api/v1/group-admin/tenant-context/exit", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    renderGroupAdminEquipmentPanel(authority);
    await user.click(screen.getByRole("button", { name: "장비 등록" }));
    await user.selectOptions(screen.getByLabelText("소유 법인"), "org-knl");
    await user.click(
      screen.getByLabelText(/소유 법인, 등록 권한, 회계·계약상 근거/),
    );
    await user.type(screen.getByLabelText("호기 번호"), "D-25-301");
    await user.type(screen.getByLabelText("고객명"), "신규고객");
    await user.type(screen.getByLabelText("현장명"), "신규현장");
    await user.type(screen.getByLabelText("규격"), "입식");
    await user.type(screen.getByLabelText("톤수"), "3.0T");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(delegatedRequests).toHaveBeenCalledWith(
        "Bearer knl-context-token",
      );
    });
    expect(delegatedRequests).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(await screen.findByText("장비를 등록하지 못했습니다.")).toBeVisible();
  });

  it("wires the live manage page to group-admin legal-owner selection", async () => {
    const user = userEvent.setup();
    const groupsRequested = vi.fn();
    const contextStarted = vi.fn();
    const created = vi.fn();
    const contextExited = vi.fn();

    server.use(
      ...searchHandlers(),
      http.get("*/api/v1/equipment/list", () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
      ),
      http.get("*/api/v1/group-admin/groups", ({ request }) => {
        groupsRequested(request.headers.get("authorization"));
        return HttpResponse.json({
          groups: [
            {
              id: "group-1",
              slug: "group",
              name: "그룹",
              status: "ACTIVE",
              members: [
                { id: "org-coss", slug: "coss", name: "코스", status: "ACTIVE" },
                { id: "org-knl", slug: "knl", name: "케이앤엘", status: "ACTIVE" },
              ],
            },
          ],
        });
      }),
      http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
        contextStarted({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({
          access_token: "knl-context-token",
          token_type: "Bearer",
          acting_org_id: "org-knl",
          acting_org_name: "케이앤엘",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2026-06-29T00:00:00Z",
        });
      }),
      http.post("*/api/v1/equipment", async ({ request }) => {
        created({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({ id: newEquipmentId }, { status: 201 });
      }),
      http.post("*/api/v1/group-admin/tenant-context/exit", async ({ request }) => {
        contextExited({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp({
      ...makeAuthContext(delegatedCossSession),
      viewAs: {
        token: "coss-context-token",
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: "org-coss",
        actingOrgName: "코스",
        actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
        platformSession: groupAdminSourceSession,
      },
    });

    await user.click(await screen.findByRole("button", { name: "장비 등록" }));
    await waitFor(() => {
      expect(groupsRequested).toHaveBeenCalledWith("Bearer group-source-token");
    });
    await user.selectOptions(await screen.findByLabelText("소유 법인"), "org-knl");
    await user.click(
      screen.getByLabelText(/소유 법인, 등록 권한, 회계·계약상 근거/),
    );
    await user.type(screen.getByLabelText("호기 번호"), "D-25-300");
    await user.type(screen.getByLabelText("고객명"), "신규고객");
    await user.type(screen.getByLabelText("현장명"), "신규현장");
    await user.type(screen.getByLabelText("규격"), "입식");
    await user.type(screen.getByLabelText("톤수"), "3.0T");

    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(contextStarted).toHaveBeenCalledWith({
        authorization: "Bearer group-source-token",
        body: { org_id: "org-knl" },
      });
      expect(created).toHaveBeenCalledWith({
        authorization: "Bearer knl-context-token",
        body: expect.objectContaining({
          equipment_no: "D-25-300",
          customer_name: "신규고객",
          site_name: "신규현장",
        }),
      });
      expect(contextExited).toHaveBeenCalledWith({
        authorization: "Bearer group-source-token",
        body: { org_id: "org-knl" },
      });
    });
  });

  it("edits an existing equipment row", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    server.use(
      ...searchHandlers(),
      http.patch("*/api/v1/equipment/:id", async ({ request, params }) => {
        patched({ id: params.id, body: await request.json() });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp(makeAuthContext(adminSession));
    await typeSearch(user);

    await user.click(await screen.findByRole("button", { name: "D-25-290 수정" }));

    const customerInput = screen.getByLabelText("고객명");
    await user.clear(customerInput);
    await user.type(customerInput, "변경고객");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith(
        expect.objectContaining({
          id: equipmentId,
          body: expect.objectContaining({ customer_name: "변경고객" }),
        }),
      );
    });
  });

  it("requests legal ownership transfer through the ordered approval workflow", async () => {
    const user = userEvent.setup();
    const transferRequested = vi.fn();
    server.use(
      http.post(
        "*/api/v1/equipment/:id/ownership-transfer-requests",
        async ({ request, params }) => {
          transferRequested({
            id: params.id,
            body: await request.json(),
          });
          return HttpResponse.json(
            {
              id: "77777777-7777-4777-8777-777777777777",
              equipment_id: equipmentId,
              branch_id: branchId,
              from_owner: "코스",
              to_owner: "케이앤엘",
              reason: "KNL 운영 자산",
              status: "PENDING",
              current_step: "sending_org_admin",
              approval_line: [
                { step_key: "sending_org_admin", label: "이전 법인 승인", status: "PENDING" },
                { step_key: "receiving_org_admin", label: "인수 법인 승인", status: "WAITING" },
                { step_key: "legal_signoff", label: "법무 소유권 검토", status: "WAITING" },
                { step_key: "accounting_signoff", label: "회계 자산대장 반영", status: "WAITING" },
              ],
              requested_by: "group-admin-1",
              requested_at: "2026-06-29T00:00:00Z",
              decided_at: null,
              completed_at: null,
            },
            { status: 201 },
          );
        },
      ),
    );

    renderGroupAdminEquipmentPanel();

    await user.click(await screen.findByRole("button", { name: "D-25-290 수정" }));
    await user.selectOptions(screen.getByLabelText("새 법적 소유자"), "케이앤엘");
    await user.type(screen.getByLabelText("이전 사유"), "KNL 운영 자산");
    await user.click(
      screen.getByLabelText(/양 법인, 법무, 회계 승인 전에는/),
    );
    await user.click(screen.getByRole("button", { name: "소유권 이전 결재 요청" }));

    await waitFor(() => {
      expect(transferRequested).toHaveBeenCalledWith({
        id: equipmentId,
        body: {
          to_owner: "케이앤엘",
          reason: "KNL 운영 자산",
        },
      });
    });
    expect(await screen.findByText("소유권 이전 결재를 요청했습니다.")).toBeVisible();
  });

  it("uses reference dropdowns and derives known fields from the selected model", async () => {
    const user = userEvent.setup();
    server.use(...searchHandlers());

    renderApp(makeAuthContext(adminSession));
    await typeSearch(user);
    await user.click(await screen.findByRole("button", { name: "장비 등록" }));

    await user.click(screen.getByLabelText("모델"));
    await user.click(await screen.findByRole("option", { name: "GTS25DE" }));

    expect(screen.getByLabelText("제조사")).toHaveValue("현대");
    expect(screen.getByLabelText("규격")).toHaveValue("좌식");
    expect(screen.getByLabelText("톤수")).toHaveValue("2.5T");

    await user.click(screen.getByLabelText("고객명"));
    await user.click(await screen.findByRole("option", { name: "케이앤엘" }));
    expect(screen.getByLabelText("고객명")).toHaveValue("케이앤엘");

    await user.click(screen.getByLabelText("현장명"));
    await user.click(await screen.findByRole("option", { name: "본사" }));
    expect(screen.getByLabelText("현장명")).toHaveValue("본사");
  });

  it("soft-deletes equipment behind a confirm dialog", async () => {
    const user = userEvent.setup();
    const deleted = vi.fn();
    server.use(
      ...searchHandlers(),
      http.delete("*/api/v1/equipment/:id", ({ params }) => {
        deleted(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp(makeAuthContext(adminSession));
    await typeSearch(user);

    await user.click(await screen.findByRole("button", { name: "D-25-290 폐기" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "폐기" }));

    await waitFor(() => {
      expect(deleted).toHaveBeenCalledWith(equipmentId);
    });
    expect(await screen.findByText("장비를 폐기 처리했습니다.")).toBeVisible();
  });

  it("redirects a mechanic away from /equipment/manage to the browse page", async () => {
    server.use(
      ...searchHandlers(),
      http.get("*/api/v1/equipment/list", () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    renderApp(makeAuthContext(mechanicSession));

    // RequireEquipmentManageRoute redirects non-holders to the browse page.
    expect(
      await screen.findByRole("heading", { name: "장비 조회", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "장비 등록" }),
    ).not.toBeInTheDocument();
  });
});
