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
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    window.dispatchEvent(new Event("pagehide"));
    const error = captured.find((m) => m.name === "error");
    expect(error?.detail).toBe("boom");
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
