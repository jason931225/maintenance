import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { getDeviceId } from "../api/device";
import { useAuth } from "../context/auth";

const TELEMETRY_PATH = "/api/v1/console/telemetry/route";
const ROUTE_ERROR_EVENT = "maintenance:route-error";
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_TOKEN_SEGMENT = /^[0-9a-z_-]{24,}$/i;
const SAFE_RELEASE = /^[A-Za-z0-9._:-]{1,80}$/;

type RouteSurface = "console" | "legacy";
type TelemetryEventKind = "route_selection" | "rum_error" | "rum_perf";

interface TelemetryPayload {
  event_kind: TelemetryEventKind;
  route_surface: RouteSurface;
  route_path: string;
  release_cycle: string;
  duration_ms?: number;
  error_name?: string;
}

interface RouteTelemetrySnapshot {
  accessToken: string | undefined;
  isPlatform: boolean | undefined;
  pathname: string;
}

function telemetryUrl(): string {
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  return baseUrl ? `${baseUrl}${TELEMETRY_PATH}` : TELEMETRY_PATH;
}

function releaseCycle(): string {
  const raw =
    import.meta.env.VITE_RELEASE_CYCLE ??
    import.meta.env.VITE_APP_VERSION ??
    import.meta.env.VITE_GIT_SHA;
  return typeof raw === "string" && SAFE_RELEASE.test(raw) ? raw : "dev";
}

function sanitizePathSegment(segment: string): string {
  if (UUID_SEGMENT.test(segment)) return ":id";
  if (/^\d+$/.test(segment)) return ":id";
  if (LONG_TOKEN_SEGMENT.test(segment)) return ":id";
  return segment.replace(/[^A-Za-z0-9._~:-]/g, "_").slice(0, 48);
}

function cardinalitySafeRoutePath(pathname: string): string {
  const [pathOnly] = pathname.split(/[?#]/, 1);
  const segments = pathOnly.split("/").filter(Boolean).map(sanitizePathSegment);
  if (segments.length === 0) return "/";
  return `/${segments.join("/")}`.slice(0, 120);
}

function detectRouteSurface(pathname: string): RouteSurface {
  if (pathname.startsWith("/console")) return "console";
  if (typeof document !== "undefined" && document.querySelector("[data-console-root]")) {
    return "console";
  }
  return "legacy";
}

function boundedErrorName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  const bounded = name || "UnknownError";
  return bounded.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

function shouldRecord(snapshot: RouteTelemetrySnapshot): snapshot is RouteTelemetrySnapshot & {
  accessToken: string;
} {
  return Boolean(snapshot.accessToken && !snapshot.isPlatform);
}

function postTelemetry(accessToken: string, payload: TelemetryPayload): void {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Auth-Transport": "cookie",
  };
  const deviceId = getDeviceId();
  if (deviceId) headers["X-Device-Id"] = deviceId;

  void fetch(telemetryUrl(), {
    method: "POST",
    headers,
    credentials: "include",
    keepalive: true,
    body: JSON.stringify(payload),
  }).catch(() => {
    // Telemetry must never break route selection or error recovery.
  });
}

function payloadFor(
  eventKind: TelemetryEventKind,
  pathname: string,
  extras: Partial<Pick<TelemetryPayload, "duration_ms" | "error_name">> = {},
): TelemetryPayload {
  return {
    event_kind: eventKind,
    route_surface: detectRouteSurface(pathname),
    route_path: cardinalitySafeRoutePath(pathname),
    release_cycle: releaseCycle(),
    ...extras,
  };
}

function customRouteErrorName(event: Event): string | undefined {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return undefined;
  if (!("error_name" in detail)) return undefined;
  return boundedErrorName(detail.error_name);
}

function errorEventName(event: ErrorEvent): string {
  return boundedErrorName(event.error instanceof Error ? event.error.name : "WindowError");
}

function rejectionEventName(event: PromiseRejectionEvent): string {
  return boundedErrorName(event.reason instanceof Error ? event.reason.name : "UnhandledRejection");
}

/**
 * Route/RUM telemetry bridge for staged carbon-copy rollout decisions.
 *
 * The backend derives org/user from the bearer token; this component sends only a
 * cardinality-safe route template plus bounded event labels. It intentionally
 * skips platform-tier sessions because `/api/v1/*` tenant telemetry rejects
 * platform tokens and ramp decisions are per tenant org.
 */
export function RouteTelemetry() {
  const location = useLocation();
  const { session } = useAuth();
  const snapshot = useRef<RouteTelemetrySnapshot>({
    accessToken: session?.access_token,
    isPlatform: session?.isPlatform,
    pathname: location.pathname,
  });

  useEffect(() => {
    snapshot.current = {
      accessToken: session?.access_token,
      isPlatform: session?.isPlatform,
      pathname: location.pathname,
    };
  }, [location.pathname, session?.access_token, session?.isPlatform]);

  useEffect(() => {
    const current = snapshot.current;
    if (!shouldRecord(current)) return undefined;

    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      postTelemetry(
        current.accessToken,
        payloadFor("route_selection", current.pathname, { duration_ms: durationMs }),
      );
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [location.pathname, session?.access_token, session?.isPlatform]);

  useEffect(() => {
    function recordRumError(errorName: string) {
      const current = snapshot.current;
      if (!shouldRecord(current)) return;
      postTelemetry(
        current.accessToken,
        payloadFor("rum_error", current.pathname, { error_name: boundedErrorName(errorName) }),
      );
    }

    function onRouteError(event: Event) {
      recordRumError(customRouteErrorName(event) ?? "RouteBoundaryError");
    }

    function onWindowError(event: ErrorEvent) {
      recordRumError(errorEventName(event));
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      recordRumError(rejectionEventName(event));
    }

    window.addEventListener(ROUTE_ERROR_EVENT, onRouteError);
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener(ROUTE_ERROR_EVENT, onRouteError);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
