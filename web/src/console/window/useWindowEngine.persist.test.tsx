// Persistence-safety coverage for the window engine (charter §3 P0.2).
//
// The interaction/grammar tests run with persist:false; these exercise the real
// GET/PUT branch with a mock client to prove the two data-safety invariants:
//   (a) a failed initial GET never lets a later edit clobber the server layout;
//   (b) a successful load's unrelated top-level keys survive the merge-on-write.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { CardRegistry } from "./types";
import { useWindowEngine } from "./useWindowEngine";

const REGISTRY: CardRegistry = {
  a: { off: 214, main: ["roster"], side: ["issues", "board"], min: { roster: 340, issues: 300, board: 360 } },
};

function makeApi(
  get: () => Promise<unknown>,
  put: () => Promise<unknown> = () =>
    Promise.resolve({ data: { layout: {} }, response: { ok: true } }),
): ConsoleApiClient {
  return { GET: vi.fn(get), PUT: vi.fn(put) } as unknown as ConsoleApiClient;
}

async function mount(api: ConsoleApiClient) {
  let hook!: ReturnType<typeof renderHook<ReturnType<typeof useWindowEngine>, void>>;
  await act(async () => {
    hook = renderHook(() =>
      useWindowEngine({ registry: REGISTRY, api, ownerKey: "u1" }),
    );
    await Promise.resolve(); // let the awaited GET resolve + hydrate
    await Promise.resolve();
  });
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useWindowEngine persistence safety", () => {
  it("never PUTs after a failed load (saveEnabled data-loss guard)", async () => {
    const api = makeApi(() => Promise.reject(new Error("boom")));
    const hook = await mount(api);
    expect(hook.result.current.loading).toBe(false);

    act(() => {
      hook.result.current.pinRight("a", "issues");
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("also treats a non-ok HTTP response as a failed load (no PUT)", async () => {
    const api = makeApi(() =>
      Promise.resolve({ data: undefined, response: { ok: false } }),
    );
    const hook = await mount(api);
    act(() => {
      hook.result.current.pinRight("a", "issues");
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("merges on write — unrelated top-level keys (v/panels) survive our save", async () => {
    const panels = [
      {
        screen: "overview",
        area: "left",
        mode: "pinned",
        object: { kind: "workOrder", code: "WO-1" },
      },
    ];
    const put = vi.fn(() =>
      Promise.resolve({ data: { layout: {} }, response: { ok: true } }),
    );
    const api = makeApi(
      () =>
        Promise.resolve({
          data: { layout: { v: 1, panels, consoleWindow: {} } },
          response: { ok: true },
        }),
      put,
    );
    const hook = await mount(api);
    expect(hook.result.current.loading).toBe(false);

    act(() => {
      hook.result.current.pinRight("a", "issues");
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(put).toHaveBeenCalledTimes(1);
    const body = (put.mock.calls[0]?.[1] as { body: { layout: Record<string, unknown> } })
      .body.layout;
    expect(body.v).toBe(1); // legacy shell's envelope version preserved
    expect(body.panels).toEqual(panels); // legacy shell's panels intact
    expect(body.consoleWindow).toBeDefined(); // our own engine state written
  });
});
