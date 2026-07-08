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
  fields: [],
};

const support: PinnedObject = {
  kind: "support",
  code: "SUP-1",
  title: "S",
  fields: [],
};

function serverPanel(object: PinnedObject): Panel {
  return {
    id: `work-hub:${object.kind}:${object.code}`,
    screen: "work-hub",
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

async function mount(api: ConsoleApiClient) {
  await act(async () => {
    renderHook(() => {
      useWorkspacePersistence(api, true);
    });
    await Promise.resolve(); // let the awaited GET resolve and hydrate
  });
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
      useWorkspaceStore.getState().pin("work-hub", wo);
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
      useWorkspaceStore.getState().pin("work-hub", wo);
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
      useWorkspacePersistence(api, true);
    });
    act(() => {
      useWorkspaceStore.getState().pin("work-hub", wo, "right");
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
    ).toEqual(["work-hub:support:SUP-1", "work-hub:workOrder:WO-1"]);
    await tick(600);
    expect(api.PUT).toHaveBeenCalledTimes(1);
    expect(api.PUT).toHaveBeenLastCalledWith(
      "/api/v1/me/workspace",
      expect.objectContaining({
        body: expect.objectContaining({
          layout: expect.objectContaining({
            panels: expect.arrayContaining([
              expect.objectContaining({ object: wo }),
              expect.objectContaining({ object: support }),
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
      useWorkspaceStore.getState().pin("work-hub", wo);
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
              expect.objectContaining({ object: wo }),
            ]),
          }),
        }),
      }),
    );
  });

  it("treats a non-ok HTTP response as a failed load", async () => {
    const api = makeApi(() =>
      Promise.resolve({ data: undefined, response: { ok: false } }),
    );
    await mount(api);
    expect(useWorkspaceStore.getState().saveEnabled).toBe(false);
  });
});
