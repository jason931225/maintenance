import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { PinPanel } from "../../components/shell/workspace/PinPanel";
import { ko } from "../../i18n/ko";
import { branchId, workOrderListItems } from "../../test/fixtures";
import { candidateToPin } from "./adapters";
import type { PinnedObject } from "./types";

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

function authValue(): AuthContextValue {
  const session: AuthSession = {
    access_token: "t",
    user_id: "u1",
    display_name: "테스터",
    roles: ["ADMIN"],
    branches: [branchId],
    feature_grants: [],
  };
  return {
    session,
    restoring: false,
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => {},
    api: createConsoleApiClient(session.access_token),
  };
}

const noop = () => {};
function woPin(refId: string): PinnedObject {
  return {
    kind: "workOrder",
    code: "WO-20260612-001",
    title: "스냅샷 제목",
    fields: [{ label: "유형", value: "정비" }],
    refId,
  };
}

function renderPanel(object: PinnedObject, withAuth: boolean) {
  const panel = (
    <PinPanel object={object} onMinimize={noop} onPopout={noop} onClose={noop} />
  );
  return render(
    withAuth ? <AuthContext.Provider value={authValue()}>{panel}</AuthContext.Provider> : panel,
  );
}

describe("PinPanel live detail (usePinDetail, #21 wiring)", () => {
  it("fetches the detail on mount and enriches the pinned snapshot", async () => {
    const wo = workOrderListItems[0];
    server.use(http.get("*/api/v1/work-orders/:id", () => HttpResponse.json(wo)));

    renderPanel(woPin(wo.id), true);

    // Snapshot renders instantly; the live status label arrives after the fetch.
    expect(screen.getByText("스냅샷 제목")).toBeInTheDocument();
    expect(await screen.findByText(ko.status[wo.status])).toBeInTheDocument();
  });

  it("shows an error state when the detail fetch fails", async () => {
    server.use(
      http.get("*/api/v1/work-orders/:id", () => HttpResponse.json({ error: "x" }, { status: 500 })),
    );

    renderPanel(woPin(workOrderListItems[0].id), true);

    expect(await screen.findByRole("alert")).toHaveTextContent(ko.page.loadFailed);
  });

  it("keeps the snapshot without an error banner when the detail is forbidden or missing", async () => {
    let requested = false;
    server.use(
      http.get("*/api/v1/work-orders/:id", () => {
        requested = true;
        return HttpResponse.json({ error: "forbidden" }, { status: 403 });
      }),
    );

    renderPanel(woPin(workOrderListItems[0].id), true);

    expect(screen.getByText("스냅샷 제목")).toBeInTheDocument();
    await waitFor(() => {
      expect(requested).toBe(true);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resyncs snapshot-only pins when the pinned object changes without a live detail fetch", () => {
    const first: PinnedObject = {
      kind: "approval",
      code: "APP-1",
      title: "첫 승인",
      fields: [],
    };
    const second: PinnedObject = {
      kind: "approval",
      code: "APP-2",
      title: "둘째 승인",
      fields: [],
    };
    const view = renderPanel(first, true);

    expect(screen.getByText("첫 승인")).toBeInTheDocument();
    view.rerender(
      <AuthContext.Provider value={authValue()}>
        <PinPanel object={second} onMinimize={noop} onPopout={noop} onClose={noop} />
      </AuthContext.Provider>,
    );

    expect(screen.getByText("둘째 승인")).toBeInTheDocument();
    expect(screen.queryByText("첫 승인")).not.toBeInTheDocument();
  });

  it("a person pin (from a palette candidate) fetches members/{id} on mount — the view-audit trigger", async () => {
    const personId = "22222222-2222-4222-8222-222222222222";
    let hit = "";
    server.use(
      http.get("*/api/messenger/members/:userId", ({ params }) => {
        hit = String(params.userId);
        return HttpResponse.json({ id: personId, display_name: "홍길동", team: "MAINTENANCE" });
      }),
    );
    // The exact PinnedObject the ⌘K palette pins for a person candidate.
    const personPin = candidateToPin({ kind: "person", code: personId, label: "홍길동" });
    if (!personPin) throw new Error("person candidate must be pinnable");
    renderPanel(personPin, true);

    expect(await screen.findByText("홍길동")).toBeInTheDocument();
    expect(hit).toBe(personId); // GET /api/messenger/members/{id} issued → server records person.view
  });

  it("renders the snapshot without fetching when there is no auth provider", () => {
    // No AuthContext → nullable useContext → no fetch, no crash.
    renderPanel(woPin("any-id"), false);
    expect(screen.getByText("스냅샷 제목")).toBeInTheDocument();
  });
});
