import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { useWorkspacePersistence } from "./persistence";
import { useWorkspaceStore } from "./store";
import type { Panel, PinnedObject } from "./types";

const wo: PinnedObject = {
  kind: "workOrder",
  code: "WO-1",
  title: "T",
  fields: [{ label: "customer", value: "Acme" }],
  href: "/work-orders/WO-1",
};

const support: PinnedObject = {
  kind: "support",
  code: "SUP-1",
  title: "S",
  fields: [],
};

function serverPanel(object: PinnedObject): Panel {
  return {
    id: `overview:${object.kind}:${object.code}`,
    screen: "overview",
    area: "left",
    mode: "pinned",
    object,
  };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  if (!resolve) throw new Error("deferred resolve was not initialized");
  return { promise, resolve };
}

function makeApi(
  get: () => Promise<unknown>,
  put: () => Promise<unknown> = () =>
    Promise.resolve({ data: { layout: {} }, response: { ok: true } }),
): ConsoleApiClient {
  return {
    GET: vi.fn(get),
    PUT: vi.fn(put),
  } as unknown as ConsoleApiClient;
}

const okEmpty = () =>
  Promise.resolve({
    data: { layout: { v: 1, panels: [] } },
    response: { ok: true },
  });

beforeEach(() => {
  vi.useFakeTimers();
  useWorkspaceStore.setState({
    ownerKey: null,
    panels: [],
    hydrated: false,
    saveEnabled: false,
    snapPreview: null,
    draggingId: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(api: ConsoleApiClient, ownerKey = "org-a:user-a") {
  let hook!: ReturnType<typeof renderHook<{ api: ConsoleApiClient; ownerKey: string }, void>>;
  await act(async () => {
    hook = renderHook(
      ({ api: activeApi, ownerKey: activeOwner }) => {
        useWorkspacePersistence(activeApi, true, activeOwner);
      },
      { initialProps: { api, ownerKey } },
    );
    await Promise.resolve(); // let the awaited GET resolve and hydrate
  });
  return hook;
}

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve(); // flush the debounced PUT promise
    await Promise.resolve(); // flush catch/finally rescheduling
  });
}

describe("useWorkspacePersistence", () => {
  it("does not PUT on the hydrate transition (mount)", async () => {
    const api = makeApi(okEmpty);
    await mount(api);
    expect(useWorkspaceStore.getState().hydrated).toBe(true);
    await tick(2000);
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("saves edits after a successful (even empty) load", async () => {
    const api = makeApi(okEmpty);
    await mount(api);
    expect(useWorkspaceStore.getState().saveEnabled).toBe(true);
    act(() => {
      useWorkspaceStore.getState().pin("overview", wo);
    });
    await tick(600);
    expect(api.PUT).toHaveBeenCalledTimes(1);
  });

  it("does NOT save after a failed load (never clobbers the server layout)", async () => {
    const api = makeApi(() => Promise.reject(new Error("boom")));
    await mount(api);
    expect(useWorkspaceStore.getState().hydrated).toBe(true);
    expect(useWorkspaceStore.getState().saveEnabled).toBe(false);
    act(() => {
      useWorkspaceStore.getState().pin("overview", wo);
    });
    await tick(2000);
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("preserves and saves edits made before initial hydrate resolves", async () => {
    const load = deferred<{
      data: { layout: { v: 1; panels: Panel[] } };
      response: { ok: true };
    }>();
    const api = makeApi(() => load.promise);

    renderHook(() => {
      useWorkspacePersistence(api, true, "org-a:user-a");
    });
    await act(async () => {
      await Promise.resolve(); // let owner reset + GET kickoff run
    });
    act(() => {
      useWorkspaceStore.getState().pin("overview", wo, "right");
    });
    await act(async () => {
      load.resolve({
        data: { layout: { v: 1, panels: [serverPanel(support)] } },
        response: { ok: true },
      });
      await Promise.resolve();
    });

    expect(
      useWorkspaceStore.getState().panels.map((panel) => panel.id),
    ).toEqual(["overview:support:SUP-1", "overview:workOrder:WO-1"]);
    await tick(600);
    expect(api.PUT).toHaveBeenCalledTimes(1);
    expect(api.PUT).toHaveBeenLastCalledWith(
      "/api/v1/me/workspace",
      expect.objectContaining({
        body: expect.objectContaining({
          layout: expect.objectContaining({
            panels: expect.arrayContaining([
              expect.objectContaining({
                object: { kind: wo.kind, code: wo.code },
              }),
              expect.objectContaining({
                object: { kind: support.kind, code: support.code },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("retains and retries dirty edits after a failed PUT", async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce({ data: { layout: {} }, response: { ok: true } });
    const api = makeApi(okEmpty, put);
    await mount(api);
    act(() => {
      useWorkspaceStore.getState().pin("overview", wo);
    });

    await tick(600);
    expect(api.PUT).toHaveBeenCalledTimes(1);

    await tick(600);
    expect(api.PUT).toHaveBeenCalledTimes(2);
    expect(api.PUT).toHaveBeenLastCalledWith(
      "/api/v1/me/workspace",
      expect.objectContaining({
        body: expect.objectContaining({
          layout: expect.objectContaining({
            panels: expect.arrayContaining([
              expect.objectContaining({
                object: { kind: wo.kind, code: wo.code },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("persists only stable object refs, not domain snapshots or hrefs", async () => {
    const api = makeApi(okEmpty);
    await mount(api);
    act(() => {
      useWorkspaceStore.getState().pin("overview", wo);
    });

    await tick(600);

    expect(api.PUT).toHaveBeenCalledWith(
      "/api/v1/me/workspace",
      expect.objectContaining({
        body: expect.objectContaining({
          layout: expect.objectContaining({
            panels: [
              expect.objectContaining({
                object: { kind: "workOrder", code: "WO-1" },
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("clears and reloads when the workspace owner changes", async () => {
    const apiA = makeApi(() =>
      Promise.resolve({
        data: { layout: { v: 1, panels: [serverPanel(wo)] } },
        response: { ok: true },
      }),
    );
    const putB = vi.fn().mockResolvedValue({
      data: { layout: {} },
      response: { ok: true },
    });
    const apiB = makeApi(okEmpty, putB);
    const hook = await mount(apiA, "org-a:user-a");
    expect(useWorkspaceStore.getState().panels.map((panel) => panel.id)).toEqual([
      "overview:workOrder:WO-1",
    ]);

    act(() => {
      hook.rerender({ api: apiB, ownerKey: "org-b:user-b" });
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      ownerKey: "org-b:user-b",
      panels: [],
      hydrated: false,
      saveEnabled: false,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      ownerKey: "org-b:user-b",
      panels: [],
      hydrated: true,
      saveEnabled: true,
    });
    act(() => {
      useWorkspaceStore.getState().pin("overview", support);
    });
    await tick(600);

    expect(putB).toHaveBeenCalledTimes(1);
    expect(putB).toHaveBeenCalledWith(
      "/api/v1/me/workspace",
      expect.objectContaining({
        body: expect.objectContaining({
          layout: expect.objectContaining({
            panels: [
              expect.objectContaining({
                object: { kind: "support", code: "SUP-1" },
              }),
            ],
          }),
        }),
      }),
    );
    expect(JSON.stringify(putB.mock.calls)).not.toContain("WO-1");
  });

  it("does not retry a failed save after unmount", async () => {
    const write = deferred<unknown>();
    const put = vi.fn(() => write.promise);
    const api = makeApi(okEmpty, put);
    const hook = await mount(api);
    act(() => {
      useWorkspaceStore.getState().pin("overview", wo);
    });

    await tick(600);
    expect(put).toHaveBeenCalledTimes(1);
    hook.unmount();

    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: undefined,
    });
    try {
      await act(async () => {
        write.resolve({ response: { ok: false } });
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      }
    }

    await tick(1_200);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("treats a non-ok HTTP response as a failed load", async () => {
    const api = makeApi(() =>
      Promise.resolve({ data: undefined, response: { ok: false } }),
    );
    await mount(api);
    expect(useWorkspaceStore.getState().saveEnabled).toBe(false);
  });
});
