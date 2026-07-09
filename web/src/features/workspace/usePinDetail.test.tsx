import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { PinPanel } from "../../components/shell/workspace/PinPanel";
import { ko } from "../../i18n/ko";
import { branchId, workOrderListItems } from "../../test/fixtures";
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

  it("renders the snapshot without fetching when there is no auth provider", () => {
    // No AuthContext → nullable useContext → no fetch, no crash.
    renderPanel(woPin("any-id"), false);
    expect(screen.getByText("스냅샷 제목")).toBeInTheDocument();
  });
});
