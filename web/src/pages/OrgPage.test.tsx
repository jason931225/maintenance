import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";

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

const REGION = "r1";
const regions = [
  { id: REGION, name: "수도권", created_at: "2026-01-01T00:00:00Z" },
];
const branches = [
  {
    id: "b1",
    region_id: REGION,
    name: "강남지점",
    created_at: "2026-01-01T00:00:00Z",
  },
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

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const adminSession: AuthSession = { access_token: "a", roles: ["ADMIN"] };

describe("OrgPage", () => {
  it("redirects a non-admin away from /settings/org", async () => {
    renderApp(
      "/settings/org",
      makeAuthContext({ access_token: "a", roles: ["RECEPTIONIST"] }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "지역·지점 관리" }),
      ).not.toBeInTheDocument();
    });
  });

  it("lists regions and branches", async () => {
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    // "수도권" appears both in the region list and the branch-region <select>.
    expect((await screen.findAllByText("수도권")).length).toBeGreaterThan(0);
    expect(screen.getByText("강남지점")).toBeVisible();
  });

  it("creates a region", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/regions", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          { id: "r2", name: "충청권", created_at: "2026-01-01T00:00:00Z" },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    await screen.findAllByText("수도권");
    await user.type(screen.getByLabelText("지역명"), "충청권");
    await user.click(screen.getByRole("button", { name: "지역 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({ name: "충청권" });
    });
  });

  it("creates a branch referencing a region", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/branches", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          {
            id: "b2",
            region_id: REGION,
            name: "분당지점",
            created_at: "2026-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    await screen.findByText("강남지점");
    await user.type(screen.getByLabelText("지점명"), "분당지점");
    await user.selectOptions(screen.getByLabelText("지역"), REGION);
    await user.click(screen.getByRole("button", { name: "지점 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        name: "분당지점",
        region_id: REGION,
      });
    });
  });

  it("edits an existing region", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.patch("*/api/v1/regions/:id", async ({ request, params }) => {
        patched({ id: params.id, body: await request.json() });
        return HttpResponse.json(
          {
            id: REGION,
            name: "경기권",
            deactivated_at: null,
            created_at: "2026-01-01T00:00:00Z",
          },
          { status: 200 },
        );
      }),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    // "수도권" appears in both the region list <li> and the branch-region
    // <select> <option>; the editable region row is the <li> instance.
    const regionMatches = await screen.findAllByText("수도권");
    const regionRow = regionMatches
      .map((el) => el.closest("li"))
      .find((li): li is HTMLLIElement => li !== null);
    expect(regionRow).toBeDefined();
    await user.click(
      within(regionRow as HTMLLIElement).getByRole("button", { name: "수정" }),
    );

    // The inline edit form replaces the row in place. "지역명" labels both the
    // create form input (#region-name) and the inline edit input — pick the edit
    // one (the input without the create form's id).
    const nameInput = (await screen.findAllByLabelText("지역명")).find(
      (el) => el.id !== "region-name",
    );
    expect(nameInput).toBeDefined();
    await user.clear(nameInput as HTMLElement);
    await user.type(nameInput as HTMLElement, "경기권");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        id: REGION,
        body: { name: "경기권" },
      });
    });
  });

  it("deactivates a branch after confirming", async () => {
    const user = userEvent.setup();
    const deleted = vi.fn();
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.delete("*/api/v1/branches/:id", ({ params }) => {
        deleted(params.id);
        return HttpResponse.json(
          {
            id: "b1",
            region_id: REGION,
            name: "강남지점",
            deactivated_at: "2026-02-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
          },
          { status: 200 },
        );
      }),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    // The branch row (owns "강남지점") exposes a 삭제 (delete) affordance.
    const branchRow = (await screen.findByText("강남지점")).closest("li");
    expect(branchRow).not.toBeNull();
    await user.click(
      within(branchRow as HTMLLIElement).getByRole("button", { name: "삭제" }),
    );

    // A confirm dialog appears; confirming issues the DELETE.
    const dialog = await screen.findByRole("dialog", { name: "지점 삭제" });
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(deleted).toHaveBeenCalledWith("b1");
    });
  });

  it("surfaces the 409 referential guard when a branch is still referenced", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/regions", () => HttpResponse.json(regions)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.delete("*/api/v1/branches/:id", () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message:
                "이 지점에 배정된 활성 사용자가 있어 삭제할 수 없습니다.",
            },
          },
          { status: 409 },
        ),
      ),
    );

    renderApp("/settings/org", makeAuthContext(adminSession));

    const branchRow = (await screen.findByText("강남지점")).closest("li");
    expect(branchRow).not.toBeNull();
    await user.click(
      within(branchRow as HTMLLIElement).getByRole("button", { name: "삭제" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "지점 삭제" });
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    // The guard message is shown rather than a generic failure.
    expect(
      await screen.findByText(
        /활성 사용자 또는 등록된 장비가 있어 삭제할 수 없습니다/,
      ),
    ).toBeVisible();
  });
});
