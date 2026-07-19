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
import { listGroupAdminGroups } from "./groupAdmin";
import type { GroupAdminApiError } from "./groupAdmin";

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
    "group-source-incarnation",
  );
  const refresh = vi.fn(() => Promise.resolve({ access_token: "fresh-group-token" }));
  const registration = setRefreshCallbacks(authority, refresh, () => {});
  return { authority, refresh, registration };
}

describe("group-admin raw transport refresh authority", () => {
  it("retries a stale bearer only through its explicit current authority", async () => {
    const { authority, refresh } = registeredAuthority();
    const seen: string[] = [];
    server.use(
      http.get("*/api/v1/group-admin/groups", ({ request }) => {
        const bearer = request.headers.get("authorization") ?? "";
        seen.push(bearer);
        return bearer === "Bearer fresh-group-token"
          ? HttpResponse.json({ groups: [] })
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }),
    );

    await expect(listGroupAdminGroups("stale-group-token", authority)).resolves.toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["Bearer stale-group-token", "Bearer fresh-group-token"]);
  });

  it("deduplicates concurrent 401 recovery for the same authority", async () => {
    const { authority, refresh } = registeredAuthority();
    server.use(
      http.get("*/api/v1/group-admin/groups", ({ request }) =>
        request.headers.get("authorization") === "Bearer fresh-group-token"
          ? HttpResponse.json({ groups: [] })
          : HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    await expect(
      Promise.all([
        listGroupAdminGroups("stale-group-token", authority),
        listGroupAdminGroups("stale-group-token", authority),
      ]),
    ).resolves.toEqual([[], []]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a handle or with a retired authority", async () => {
    const { authority, refresh, registration } = registeredAuthority();
    server.use(
      http.get("*/api/v1/group-admin/groups", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    await expect(listGroupAdminGroups("stale-group-token")).rejects.toMatchObject<GroupAdminApiError>({
      status: 401,
    });
    registration.dispose();
    await expect(listGroupAdminGroups("stale-group-token", authority)).rejects.toMatchObject<GroupAdminApiError>({
      status: 401,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
