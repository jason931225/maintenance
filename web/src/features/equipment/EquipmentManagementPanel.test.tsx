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
import type { EquipmentLookupResponse } from "../../api/types";
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
  customer: { id: "c1", name: "케이앤엘" },
  site: { id: "s1", name: "본사" },
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

function renderApp(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/equipment"]}>
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

  it("hides management controls from a mechanic", async () => {
    const user = userEvent.setup();
    server.use(...searchHandlers());

    renderApp(makeAuthContext(mechanicSession));
    await typeSearch(user);

    // The lookup card renders, but no management surface is shown.
    await screen.findByLabelText("호기", { exact: true });
    expect(
      screen.queryByRole("button", { name: "장비 등록" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "D-25-290 폐기" }),
    ).not.toBeInTheDocument();
  });
});
