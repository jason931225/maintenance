import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { SecurityPanel } from "./SecurityPanel";

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
    api,
  };
}

function renderPanel() {
  return render(
    <AuthContext.Provider
      value={makeAuthContext({ access_token: "a", roles: ["MECHANIC"] })}
    >
      <SecurityPanel />
    </AuthContext.Provider>,
  );
}

const twoPasskeys = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: "2026-02-01T00:00:00Z",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    created_at: "2026-03-01T00:00:00Z",
    last_used_at: null,
  },
];

describe("SecurityPanel", () => {
  it("lists the user's passkeys and revokes one behind a confirm dialog", async () => {
    const user = userEvent.setup();
    let deleted: string | undefined;
    let listCalls = 0;
    server.use(
      http.get("*/api/v1/passkeys", () => {
        listCalls += 1;
        // After the delete, the second list returns only the kept passkey.
        return HttpResponse.json(
          listCalls === 1 ? twoPasskeys : [twoPasskeys[0]],
        );
      }),
      http.delete("*/api/v1/passkeys/:id", ({ params }) => {
        deleted = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPanel();

    // Both passkeys render.
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);

    // Open the confirm dialog for the second passkey, then confirm.
    await user.click(within(items[1]).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(deleted).toBe("22222222-2222-2222-2222-222222222222");
    });
    expect(await screen.findByText("패스키를 삭제했습니다.")).toBeVisible();
  });

  it("disables revoke and warns when only one passkey remains", async () => {
    server.use(
      http.get("*/api/v1/passkeys", () => HttpResponse.json([twoPasskeys[0]])),
    );

    renderPanel();

    const item = await screen.findByRole("listitem");
    expect(within(item).getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(
      screen.getByText(
        "마지막 패스키는 삭제할 수 없습니다. 먼저 다른 패스키를 등록하세요.",
      ),
    ).toBeVisible();
  });

  it("surfaces the last-passkey conflict from the server gracefully", async () => {
    const user = userEvent.setup();
    // Two passkeys client-side, but the server rejects the delete with 409 (e.g.
    // the other credential was removed concurrently). The panel shows the
    // friendly last-passkey message rather than a generic error.
    server.use(
      http.get("*/api/v1/passkeys", () => HttpResponse.json(twoPasskeys)),
      http.delete("*/api/v1/passkeys/:id", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "last passkey" } },
          { status: 409 },
        ),
      ),
    );

    renderPanel();

    const items = await screen.findAllByRole("listitem");
    await user.click(within(items[0]).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    expect(
      await screen.findByText(
        "마지막 패스키는 삭제할 수 없습니다. 먼저 다른 패스키를 등록하세요.",
      ),
    ).toBeVisible();
  });
});
