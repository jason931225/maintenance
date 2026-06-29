import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";

import { EquipmentBrowsePage } from "./EquipmentBrowsePage";
import { EquipmentManagePage } from "./EquipmentManagePage";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import type { EquipmentListItem } from "../api/types";
import { branchId } from "../test/fixtures";

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

const item: EquipmentListItem = {
  equipment_id: equipmentId,
  branch_id: branchId,
  equipment_no: "D-25-290",
  management_no: "290",
  status: "rented",
  model: "GTS25DE",
  maker: "두산",
  specification: "좌식",
  ton_text: "2.5T",
  customer_name: "케이앤엘",
  site_name: "본사",
  asset_owner: "코스",
  vin: "VIN-0001",
  updated_at: "2026-06-12T08:00:00Z",
};

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

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current path">{location.pathname}</output>;
}

function renderPage(session: AuthSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter>
        <EquipmentBrowsePage />
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function renderManagePage(session: AuthSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter>
        <EquipmentManagePage />
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

const mechanicSession: AuthSession = {
  access_token: "m",
  user_id: "mech-1",
  roles: ["MECHANIC"],
  branches: [branchId],
};

function listHandler(rows: EquipmentListItem[] = [item]) {
  return http.get("*/api/v1/equipment/list", () =>
    HttpResponse.json({ items: rows, total: rows.length, limit: 50, offset: 0 }),
  );
}

describe("EquipmentBrowsePage table", () => {
  it("renders an accessible equipment table and keeps the detail link navigable", async () => {
    const user = userEvent.setup();
    server.use(listHandler());

    renderPage(mechanicSession);

    const table = await screen.findByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "호기 번호" }),
    ).toBeVisible();
    expect(
      within(table).getByRole("button", { name: "장비 상세 보기: D-25-290" }),
    ).toBeVisible();

    await user.click(
      within(table).getByRole("link", { name: "보기: D-25-290" }),
    );

    expect(screen.getByLabelText("current path")).toHaveTextContent(
      `/equipment/${equipmentId}`,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets keyboard users activate the detail link without triggering row quick-view", async () => {
    const user = userEvent.setup();
    server.use(listHandler());

    renderPage(mechanicSession);

    const table = await screen.findByRole("table");
    const link = within(table).getByRole("link", { name: "보기: D-25-290" });
    link.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("current path")).toHaveTextContent(
      `/equipment/${equipmentId}`,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("EquipmentBrowsePage detail dialog", () => {
  it("makes the management route list-first before admin tools", async () => {
    server.use(
      listHandler(),
      http.get("*/api/v1/equipment-by-location", () =>
        HttpResponse.json({ items: [] }),
      ),
    );

    renderManagePage(adminSession);

    const listFirst = await screen.findByRole("region", {
      name: "전체 장비 목록에서 선택",
    });
    expect(listFirst).toHaveClass("bg-brand-teal/5");
    expect(await screen.findByText("D-25-290")).toBeVisible();
    expect(screen.getByRole("heading", { name: "등록·일괄작업·현장/대차 도구" })).toBeVisible();
  });

  it("opens a detail popup with the equipment details when a row is clicked", async () => {
    const user = userEvent.setup();
    server.use(listHandler());

    renderPage(mechanicSession);

    const row = await screen.findByRole("button", {
      name: "장비 상세 보기: D-25-290",
    });
    await user.click(row);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("장비 상세 정보")).toBeVisible();
    // Details from the list row are surfaced inline.
    expect(within(dialog).getByText("GTS25DE")).toBeVisible();
    expect(within(dialog).getByText("두산")).toBeVisible();
    expect(within(dialog).getByText("법적 소유자")).toBeVisible();
    expect(within(dialog).getByText("코스")).toBeVisible();
    expect(within(dialog).getByText("케이앤엘")).toBeVisible();
    expect(within(dialog).getByText("VIN-0001")).toBeVisible();
  });

  it("lets a non-manager see a read-only detail (no edit affordance)", async () => {
    const user = userEvent.setup();
    server.use(listHandler());

    renderPage(mechanicSession);

    await user.click(
      await screen.findByRole("button", { name: "장비 상세 보기: D-25-290" }),
    );

    const dialog = await screen.findByRole("dialog");
    // A mechanic gets the close button but never the in-place edit button.
    expect(
      within(dialog).getByRole("button", { name: "닫기" }),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: "수정" }),
    ).not.toBeInTheDocument();
  });

  it("lets a manager edit the equipment in place and PATCHes the change", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    const otherItem: EquipmentListItem = {
      ...item,
      equipment_id: "55555555-5555-4555-8555-555555555555",
      equipment_no: "D-25-291",
      model: "HDF30",
      maker: "현대",
      specification: "입식",
      ton_text: "3.0T",
      customer_name: "다른고객",
      site_name: "다른현장",
    };
    server.use(
      listHandler([item, otherItem]),
      http.patch("*/api/v1/equipment/:id", async ({ request, params }) => {
        patched({ id: params.id, body: await request.json() });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPage(adminSession);

    expect(
      await screen.findByRole("link", { name: "수정: D-25-290" }),
    ).toHaveAttribute("href", `/equipment/${equipmentId}`);

    await user.click(
      screen.getByRole("button", { name: "장비 상세 보기: D-25-290" }),
    );

    const dialog = await screen.findByRole("dialog");
    // Enter edit mode from the detail view.
    await user.click(within(dialog).getByRole("button", { name: "수정" }));

    const customerInput = within(dialog).getByLabelText("고객명");
    expect(customerInput).toHaveAttribute("list");
    const listId = customerInput.getAttribute("list") ?? "";
    expect(
      document
        .getElementById(listId)
        ?.querySelector('option[value="다른고객"]'),
    ).not.toBeNull();
    await user.clear(customerInput);
    await user.type(customerInput, "변경고객");

    await user.clear(within(dialog).getByLabelText("모델"));
    await user.type(within(dialog).getByLabelText("모델"), "HDF30");
    expect(within(dialog).getByLabelText("제조사")).toHaveValue("현대");
    expect(within(dialog).getByLabelText("규격")).toHaveValue("입식");
    expect(within(dialog).getByLabelText("톤수")).toHaveValue("3.0T");

    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith(
        expect.objectContaining({
          id: equipmentId,
          body: expect.objectContaining({
            customer_name: "변경고객",
            model: "HDF30",
            maker: "현대",
            specification: "입식",
            ton_text: "3.0T",
          }),
        }),
      );
    });

    // The row reflects the edit without leaving the browse list.
    await waitFor(() => {
      expect(screen.getAllByText("변경고객").length).toBeGreaterThan(0);
    });
  });
});
