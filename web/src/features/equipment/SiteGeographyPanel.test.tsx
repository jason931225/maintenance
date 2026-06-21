import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { SiteGeographyPanel } from "./SiteGeographyPanel";

const SITE = {
  site_id: "00000000-0000-4000-8000-0000000000ab",
  site_name: "E2E사업장",
  customer_name: "케이앤엘",
  branch_id: "00000000-0000-4000-8000-000000000001",
  province: "경기도",
  city: "안산시",
  address: "경기 안산시 단원구 산단로 123",
  postal_code: "15588",
  latitude: 37.32,
  longitude: 126.83,
  contact_name: null,
  contact_phone: null,
  contact_email: null,
  equipment_count: 3,
  rented_count: 2,
  spare_count: 1,
  substitution_active_count: 0,
};

let patched: { id: string; body: Record<string, unknown> } | undefined;

const server = setupServer(
  http.get("*/api/v1/equipment-by-location", () =>
    HttpResponse.json({ items: [SITE], total: 1 }),
  ),
  http.patch("*/api/v1/sites/:id", async ({ params, request }) => {
    patched = {
      id: String(params.id),
      body: (await request.json()) as Record<string, unknown>,
    };
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  patched = undefined;
});
afterAll(() => {
  server.close();
});

describe("SiteGeographyPanel representative contact", () => {
  it("lists the site and PATCHes the entered contact (#13)", async () => {
    const user = userEvent.setup();
    render(<SiteGeographyPanel api={createConsoleApiClient("token")} />);

    // The site loads into the selector, then we pick it to open the form.
    await screen.findByRole("option", { name: /E2E사업장/ });
    await user.selectOptions(screen.getByLabelText("사업장 선택"), SITE.site_id);

    await user.type(screen.getByLabelText("담당자명"), "김담당");
    await user.type(screen.getByLabelText("연락처"), "010-2625-0987");
    await user.click(screen.getByRole("button", { name: "정보 저장" }));

    await waitFor(() => {
      expect(patched?.id).toBe(SITE.site_id);
    });
    expect(patched?.body).toMatchObject({
      contact_name: "김담당",
      contact_phone: "010-2625-0987",
      // Untouched coordinate fields are echoed back from the loaded row.
      latitude: 37.32,
      longitude: 126.83,
      // Regression (#13 review): address/postal_code now round-trip from the
      // read, so an unedited save preserves them instead of nulling them.
      address: "경기 안산시 단원구 산단로 123",
      postal_code: "15588",
    });
    expect(await screen.findByText("사업장 정보를 저장했습니다.")).toBeVisible();
  });
});
