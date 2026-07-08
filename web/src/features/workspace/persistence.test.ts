import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { useWorkspacePersistence } from "./persistence";
import { useWorkspaceStore } from "./store";
import type { PinnedObject } from "./types";

const wo: PinnedObject = { kind: "workOrder", code: "WO-1", title: "T", fields: [] };

function makeApi(get: () => Promise<unknown>): ConsoleApiClient {
  return {
    GET: vi.fn(get),
    PUT: vi.fn(() => Promise.resolve({ data: { layout: {} } })),
  } as unknown as ConsoleApiClient;
}

const okEmpty = () => Promise.resolve({ data: { layout: { v: 1, panels: [] } }, response: { ok: true } });

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

  it("treats a non-ok HTTP response as a failed load", async () => {
    const api = makeApi(() => Promise.resolve({ data: undefined, response: { ok: false } }));
    await mount(api);
    expect(useWorkspaceStore.getState().saveEnabled).toBe(false);
  });
});
