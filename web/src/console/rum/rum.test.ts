import { afterEach, describe, expect, it, vi } from "vitest";

import { createRumBuffer, initConsoleRum, markConsoleRoute, type RumMetric } from "./rum";

describe("createRumBuffer", () => {
  it("buffers and flushes once, then clears", () => {
    const reporter = vi.fn();
    const buf = createRumBuffer(reporter);
    buf.record({ name: "LCP", value: 1200 });
    buf.record({ name: "error", value: 1 });
    expect(buf.size()).toBe(2);
    buf.flush();
    expect(reporter).toHaveBeenCalledOnce();
    expect(reporter.mock.calls[0][0]).toHaveLength(2);
    expect(buf.size()).toBe(0);
    buf.flush(); // empty -> no second report
    expect(reporter).toHaveBeenCalledOnce();
  });
});

describe("initConsoleRum", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("captures window errors and flushes on pagehide", () => {
    const captured: RumMetric[] = [];
    cleanup = initConsoleRum((metrics) => captured.push(...metrics));
    window.dispatchEvent(new ErrorEvent("error", { message: "secret customer text" }));
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: "secret rejection" }));
    window.dispatchEvent(new Event("pagehide"));
    const details = captured.filter((m) => m.name === "error").map((m) => m.detail);
    expect(details).toEqual(["window_error", "unhandled_rejection"]);
    expect(JSON.stringify(captured)).not.toContain("secret");
  });

  it("flushes pending metrics on cleanup", () => {
    const captured: RumMetric[] = [];
    cleanup = initConsoleRum((metrics) => captured.push(...metrics));
    window.dispatchEvent(new ErrorEvent("error", { message: "x" }));
    cleanup();
    cleanup = undefined;
    expect(captured.find((m) => m.name === "error")?.detail).toBe("window_error");
  });

  it("resets route state for each init", () => {
    const first: RumMetric[] = [];
    cleanup = initConsoleRum((metrics) => first.push(...metrics));
    markConsoleRoute("overview");
    cleanup();
    cleanup = undefined;

    const second: RumMetric[] = [];
    cleanup = initConsoleRum((metrics) => second.push(...metrics));
    markConsoleRoute("audit");
    window.dispatchEvent(new Event("pagehide"));
    expect(second.find((m) => m.name === "route")).toBeUndefined();
  });

  it("tags metrics with the active console screen", () => {
    const captured: RumMetric[] = [];
    cleanup = initConsoleRum((metrics) => captured.push(...metrics));
    markConsoleRoute("overview");
    window.dispatchEvent(new ErrorEvent("error", { message: "x" }));
    window.dispatchEvent(new Event("pagehide"));
    expect(captured.find((m) => m.name === "error")?.screen).toBe("overview");
  });
});
