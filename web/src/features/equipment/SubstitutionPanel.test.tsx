import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../../AppRouter";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import type {
  EquipmentListItem,
  EquipmentLookupResponse,
  SiteLocationGroup,
  SubstituteCandidate,
} from "../../api/types";
import { branchId } from "../../test/fixtures";

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

const sourceId = "44444444-4444-4444-8444-444444444444";
const substituteId = "55555555-5555-4555-8555-555555555555";
const substitutionId = "66666666-6666-4666-8666-666666666666";

const equipment: EquipmentLookupResponse = {
  id: sourceId,
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

const candidate: SubstituteCandidate = {
  equipment_id: substituteId,
  branch_id: branchId,
  equipment_no: "D-25-888",
  management_no: "888",
  model: "GTS25SPARE",
  status: "spare",
  specification: "좌식",
  ton_text: "2.5T",
  ton_milli: 2500,
  power_code: "DSL",
  power_label: "디젤",
  customer_name: "예비고객",
  site_name: "예비현장",
  placement_location: null,
  match_kind: "exact_ton",
  ton_delta_milli: 0,
};

const siteId = "77777777-7777-4777-8777-777777777777";

const site: SiteLocationGroup = {
  site_id: siteId,
  site_name: "본사",
  customer_id: "c1",
  customer_name: "케이앤엘",
  branch_id: branchId,
  address: null,
  postal_code: null,
  province: null,
  city: null,
  latitude: null,
  longitude: null,
  geofence_radius_m: null,
  contact_name: null,
  contact_phone: null,
  contact_email: null,
  equipment_count: 1,
  rented_count: 1,
  spare_count: 0,
  substitution_active_count: 0,
};

const siteEquipment: EquipmentListItem = {
  equipment_id: sourceId,
  branch_id: branchId,
  equipment_no: "D-25-290",
  management_no: "290",
  model: "GTS25DE",
  status: "rented",
  specification: "좌식",
  ton_text: "2.5T",
  customer_name: "케이앤엘",
  site_name: "본사",
  updated_at: "2026-06-18T00:00:00Z",
};

function makeAuthContext(session: AuthSession): AuthContextValue {
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

function renderApp(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/equipment/manage"]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "admin-1",
  roles: ["ADMIN"],
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

describe("SubstitutionPanel", () => {
  it("finds candidates, assigns a 대차, then returns it", async () => {
    const user = userEvent.setup();
    const assigned = vi.fn();
    const returned = vi.fn();
    server.use(
      ...searchHandlers(),
      http.get("*/api/v1/equipment/:id/substitutes", () =>
        HttpResponse.json({ items: [candidate], total: 1 }),
      ),
      http.post("*/api/v1/equipment-substitutions", async ({ request }) => {
        assigned(await request.json());
        return HttpResponse.json(
          {
            id: substitutionId,
            branch_id: branchId,
            source_equipment_id: sourceId,
            substitute_equipment_id: substituteId,
            assigned_by: "admin-1",
            assignment_location: "본사 정비고",
            assigned_at: "2026-06-18T00:00:00Z",
          },
          { status: 201 },
        );
      }),
      http.post(
        "*/api/v1/equipment-substitutions/:id/return",
        async ({ request, params }) => {
          returned({ id: params.id, body: await request.json() });
          return HttpResponse.json({
            id: substitutionId,
            branch_id: branchId,
            source_equipment_id: sourceId,
            substitute_equipment_id: substituteId,
            assigned_by: "admin-1",
            assignment_location: "본사 정비고",
            assigned_at: "2026-06-18T00:00:00Z",
            returned_by: "admin-1",
            returned_at: "2026-06-18T01:00:00Z",
          });
        },
      ),
    );

    renderApp(makeAuthContext(adminSession));

    // Populate the page search so the source dropdown has the down unit.
    await user.type(
      await screen.findByLabelText("호기", { exact: true }),
      "290",
    );

    const sourceSelect = await screen.findByLabelText("대상 장비");
    // The page search debounces before populating the source dropdown.
    await screen.findByRole("option", { name: "290 · GTS25DE" });
    await user.selectOptions(sourceSelect, sourceId);
    await user.click(screen.getByRole("button", { name: "대차 후보 조회" }));

    expect(await screen.findByText("예비 추천 목록")).toBeVisible();
    await user.type(screen.getByLabelText("배치 위치"), "본사 정비고");
    await user.click(screen.getByRole("button", { name: "대차 배정" }));

    await waitFor(() => {
      expect(assigned).toHaveBeenCalledWith(
        expect.objectContaining({
          source_equipment_id: sourceId,
          substitute_equipment_id: substituteId,
          assignment_location: "본사 정비고",
        }),
      );
    });
    expect(await screen.findByText("대차를 배정했습니다.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "반납" }));
    await waitFor(() => {
      expect(returned).toHaveBeenCalledWith(
        expect.objectContaining({ id: substitutionId }),
      );
    });
    expect(await screen.findByText("대차를 반납했습니다.")).toBeVisible();
  });

  it("picks a site, then loads that site's rented units into the source dropdown", async () => {
    const user = userEvent.setup();
    const listQuery = vi.fn();
    server.use(
      http.get("*/api/v1/equipment", () =>
        HttpResponse.json({ items: [], limit: 5 }),
      ),
      http.get("*/api/v1/equipment/lookup", () => HttpResponse.json(equipment)),
      http.get("*/api/v1/equipment-by-location", () =>
        HttpResponse.json({ items: [site], total: 1 }),
      ),
      http.get("*/api/v1/equipment/list", ({ request }) => {
        listQuery(new URL(request.url).searchParams.toString());
        return HttpResponse.json({
          items: [siteEquipment],
          limit: 200,
          offset: 0,
          total: 1,
        });
      }),
    );

    renderApp(makeAuthContext(adminSession));

    // The site picker is populated from the by-location aggregation.
    const siteSelect = await screen.findByLabelText("현장", { exact: true });
    await within(siteSelect).findByRole("option", { name: "본사 · 케이앤엘" });
    await user.selectOptions(siteSelect, siteId);

    // Choosing a site fetches that site's rented units (site_id + status=rented)
    // and drives the source dropdown.
    await waitFor(() => {
      expect(listQuery).toHaveBeenCalledWith(
        expect.stringContaining(`site_id=${siteId}`),
      );
    });
    expect(listQuery).toHaveBeenCalledWith(
      expect.stringContaining("status=rented"),
    );

    const sourceSelect = await screen.findByLabelText("대상 장비");
    await screen.findByRole("option", { name: "290 · GTS25DE" });
    await user.selectOptions(sourceSelect, sourceId);
    expect((sourceSelect as HTMLSelectElement).value).toBe(sourceId);
  });

  it("shows each spare candidate's tonnage, 규격, and power label", async () => {
    const user = userEvent.setup();
    server.use(
      ...searchHandlers(),
      http.get("*/api/v1/equipment/:id/substitutes", () =>
        HttpResponse.json({ items: [candidate], total: 1 }),
      ),
    );

    renderApp(makeAuthContext(adminSession));

    await user.type(
      await screen.findByLabelText("호기", { exact: true }),
      "290",
    );
    const sourceSelect = await screen.findByLabelText("대상 장비");
    await screen.findByRole("option", { name: "290 · GTS25DE" });
    await user.selectOptions(sourceSelect, sourceId);
    await user.click(screen.getByRole("button", { name: "대차 후보 조회" }));

    expect(await screen.findByText("예비 추천 목록")).toBeVisible();
    expect(screen.getByText(/톤수: 2\.5T/)).toBeVisible();
    expect(screen.getByText(/규격: 좌식/)).toBeVisible();
    expect(screen.getByText(/동력: 디젤/)).toBeVisible();
    // exact_ton candidates carry the full-compat emphasis.
    expect(screen.getByText("전체 호환")).toBeVisible();
  });
});
