/**
 * Console RUM — real-user monitoring for the carbon-copy console surface
 * (charter D1 "hyperscaler operational layer": route timing + CWV + error
 * events, wired from P0).
 *
 * There is no existing web-vitals/OTel wiring in `web/` (verified), so this uses
 * `PerformanceObserver` natively — NO new dependency. It collects LCP / CLS /
 * INP, per-screen route timings, and unhandled errors, buffers them, and flushes
 * on page-hide via a reporter. The default reporter `sendBeacon`s to
 * `VITE_RUM_ENDPOINT` when configured, else no-ops (dev). CI budget enforcement
 * lives in `e2e/perf/console-budgets.mjs` against `e2e/perf/budgets.json`.
 */

export type RumMetricName = "LCP" | "INP" | "CLS" | "route" | "error";

export interface RumMetric {
  name: RumMetricName;
  /** ms for timings; unitless for CLS; 1 for an error count. */
  value: number;
  /** The console `state.screen` this metric belongs to, when known. */
  screen?: string;
  detail?: string;
}

export type RumReporter = (metrics: readonly RumMetric[]) => void;

/** Buffer + flush. Pure (no browser APIs) so it is unit-testable directly. */
export function createRumBuffer(reporter: RumReporter) {
  let buffer: RumMetric[] = [];
  return {
    record(metric: RumMetric) {
      buffer.push(metric);
    },
    flush() {
      if (buffer.length === 0) return;
      reporter(buffer);
      buffer = [];
    },
    size() {
      return buffer.length;
    },
  };
}

function envRumEndpoint(): string | undefined {
  return (import.meta.env as Record<string, string | undefined>).VITE_RUM_ENDPOINT;
}

function defaultReporter(metrics: readonly RumMetric[]): void {
  const endpoint = envRumEndpoint();
  if (!endpoint || typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return;
  }
  navigator.sendBeacon(endpoint, JSON.stringify({ metrics }));
}

type ActiveBuffer = ReturnType<typeof createRumBuffer>;
let active: ActiveBuffer | undefined;
let activeScreen: string | undefined;
let lastRouteAt = 0;

/** Record a console screen transition. Emits the dwell-to-render delta for the
 * screen being left, then arms the next. Safe to call before init (no-op). */
export function markConsoleRoute(screen: string): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (active && activeScreen !== undefined) {
    active.record({ name: "route", value: Math.round(now - lastRouteAt), screen: activeScreen });
  }
  activeScreen = screen;
  lastRouteAt = now;
}

function observe(type: string, cb: (entries: PerformanceEntryList) => void): PerformanceObserver | undefined {
  if (typeof PerformanceObserver === "undefined") return undefined;
  try {
    const obs = new PerformanceObserver((list) => {
      cb(list.getEntries());
    });
    // `buffered` replays entries emitted before this observer attached.
    obs.observe({ type, buffered: true });
    return obs;
  } catch {
    return undefined; // unsupported entry type in this browser
  }
}

/**
 * Wire the console RUM to the current page. Returns a cleanup fn. Idempotent-ish:
 * a second call replaces the active buffer. In non-browser/test envs where
 * `PerformanceObserver` is absent it still installs error + flush handlers.
 */
export function initConsoleRum(reporter: RumReporter = defaultReporter): () => void {
  const buffer = createRumBuffer(reporter);
  active = buffer;
  const observers: PerformanceObserver[] = [];

  const lcp = observe("largest-contentful-paint", (entries) => {
    if (entries.length === 0) return;
    const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
    buffer.record({ name: "LCP", value: Math.round(last.startTime), screen: activeScreen });
  });
  if (lcp) observers.push(lcp);

  let cls = 0;
  const clsObs = observe("layout-shift", (entries) => {
    for (const e of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (!e.hadRecentInput) cls += e.value;
    }
  });
  if (clsObs) observers.push(clsObs);

  // ponytail: naive INP = the worst interaction latency seen; the real metric is
  // a windowed high-percentile (web-vitals lib). Upgrade only if the naive worst
  // case proves too noisy against the budget.
  let inp = 0;
  const inpObs = observe("event", (entries) => {
    for (const e of entries as (PerformanceEntry & { duration: number })[]) {
      if (e.duration > inp) inp = e.duration;
    }
  });
  if (inpObs) observers.push(inpObs);

  const onError = (event: ErrorEvent) => {
    buffer.record({ name: "error", value: 1, screen: activeScreen, detail: event.message });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    buffer.record({
      name: "error",
      value: 1,
      screen: activeScreen,
      detail: String(event.reason),
    });
  };

  const flush = () => {
    if (cls > 0) {
      buffer.record({ name: "CLS", value: Math.round(cls * 1000) / 1000, screen: activeScreen });
      cls = 0;
    }
    if (inp > 0) {
      buffer.record({ name: "INP", value: Math.round(inp), screen: activeScreen });
      inp = 0;
    }
    buffer.flush();
  };
  const onHidden = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") flush();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
  }

  return () => {
    for (const o of observers) o.disconnect();
    if (typeof window !== "undefined") {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    }
    if (active === buffer) active = undefined;
  };
}
