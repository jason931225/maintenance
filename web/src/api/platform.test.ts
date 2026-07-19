import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createRefreshAuthority,
  createRefreshCoordinator,
  setRefreshCallbacks,
} from "./refresh";
import { listPlatformOrgs } from "./platform";
import type { PlatformApiError } from "./platform";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function registeredAuthority() {
  const authority = createRefreshAuthority(
    createRefreshCoordinator(),
    "platform-source-incarnation",
  );
  const refresh = vi.fn(() =>
    Promise.resolve({ access_token: "fresh-platform-token" }),
  );
  const registration = setRefreshCallbacks(authority, refresh, () => {});
  return { authority, refresh, registration };
}

describe("platform raw transport refresh authority", () => {
  it("retries a stale bearer only through its explicit current authority", async () => {
    const { authority, refresh } = registeredAuthority();
    const seen: string[] = [];
    server.use(
      http.get("*/api/platform/orgs", ({ request }) => {
        const bearer = request.headers.get("authorization") ?? "";
        seen.push(bearer);
        return bearer === "Bearer fresh-platform-token"
          ? HttpResponse.json([])
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );

    await expect(listPlatformOrgs("stale-platform-token", authority)).resolves.toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      "Bearer stale-platform-token",
      "Bearer fresh-platform-token",
    ]);
  });

  it("deduplicates concurrent 401 recovery for the same authority", async () => {
    const { authority, refresh } = registeredAuthority();
    server.use(
      http.get("*/api/platform/orgs", ({ request }) =>
        request.headers.get("authorization") === "Bearer fresh-platform-token"
          ? HttpResponse.json([])
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    await expect(
      Promise.all([
        listPlatformOrgs("stale-platform-token", authority),
        listPlatformOrgs("stale-platform-token", authority),
      ]),
    ).resolves.toEqual([[], []]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a handle or with a retired authority", async () => {
    const { authority, refresh, registration } = registeredAuthority();
    server.use(
      http.get("*/api/platform/orgs", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    await expect(listPlatformOrgs("stale-platform-token")).rejects.toMatchObject<PlatformApiError>({
      status: 401,
    });
    registration.dispose();
    await expect(listPlatformOrgs("stale-platform-token", authority)).rejects.toMatchObject<PlatformApiError>({
      status: 401,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
