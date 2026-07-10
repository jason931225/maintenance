import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { RouteTelemetry } from "./routeTelemetry";

const tenantSession: AuthSession = {
  access_token: "tenant-token",
  user_id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-0000000000aa",
  roles: ["ADMIN"],
};

const platformSession: AuthSession = {
  access_token: "platform-token",
  user_id: "00000000-0000-4000-8000-000000000002",
  org_id: "00000000-0000-0000-0000-00000000face",
  roles: ["SUPER_ADMIN"],
  isPlatform: true,
};

function makeAuthContext(session: AuthSession | undefined): AuthContextValue {
  return {
    session,
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api: createConsoleApiClient(session?.access_token),
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  };
}

function renderTelemetry(
  initialEntry: string,
  session: AuthSession | undefined = tenantSession,
  child?: React.ReactNode,
) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <RouteTelemetry />
        {child}
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

type FetchMock = ReturnType<
  typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
>;

function makeFetchMock(): FetchMock {
  return vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 204 }));
}

function postInit(fetchMock: FetchMock, index = 0): RequestInit {
  const call = fetchMock.mock.calls.at(index);
  const init = call?.[1];
  if (!init) throw new Error("missing fetch init");
  return init;
}

function postedBody(fetchMock: FetchMock, index = 0): Record<string, unknown> {
  const body = postInit(fetchMock, index).body;
  if (typeof body !== "string") throw new Error("expected telemetry JSON body");
  return JSON.parse(body) as Record<string, unknown>;
}

function postedBodies(fetchMock: FetchMock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((_, index) => postedBody(fetchMock, index));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RouteTelemetry", () => {
  it("posts a cardinality-safe legacy route-selection event for tenant sessions", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderTelemetry(
      "/work-orders/11111111-1111-4111-8111-111111111111?tab=history",
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const init = postInit(fetchMock);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/console/telemetry/route");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tenant-token",
      "Content-Type": "application/json",
      "X-Auth-Transport": "cookie",
    });
    const body = postedBody(fetchMock);
    expect(body).toMatchObject({
      event_kind: "route_selection",
      route_surface: "legacy",
      route_path: "/work-orders/:id",
      release_cycle: "dev",
    });
    expect(body.duration_ms).toEqual(expect.any(Number));
  });

  it("classifies routes with the console root marker as console adoption traffic", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderTelemetry("/console/identity", tenantSession, <main data-console-root />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(postedBodies(fetchMock)[0]).toMatchObject({
      event_kind: "route_selection",
      route_surface: "console",
      route_path: "/console/identity",
    });
  });

  it("posts bounded RUM errors without leaking raw messages", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderTelemetry("/work-hub");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(
      new CustomEvent("maintenance:route-error", {
        detail: { error_name: "RouteBoundaryCrash", message: "secret raw message" },
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(postedBodies(fetchMock)[1]).toMatchObject({
      event_kind: "rum_error",
      route_surface: "legacy",
      route_path: "/work-hub",
      error_name: "RouteBoundaryCrash",
    });
    expect(JSON.stringify(postedBodies(fetchMock)[1])).not.toContain("secret raw message");
  });

  it("does not post tenant adoption telemetry for platform-tier sessions", async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderTelemetry("/platform/ops", platformSession);

    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
