import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

import type { ConsoleApiClient } from "../../api/client";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { EXPOSED_SCREEN_KEYS, type MountedScreenKey } from "../shell/nav";
import { isConsoleRolloutStatus, isNewConsoleRouteEffective } from "./status";

type BoundaryState = "checking" | "allowed" | "denied";
const ROLLOUT_AUTHORITY_TIMEOUT_MS = 5_000;

interface RolloutDecision {
  api: ConsoleApiClient;
  approvedScreenKeys: readonly MountedScreenKey[];
  state: BoundaryState;
}

export interface ConsoleRolloutBoundaryProps {
  children: ReactNode;
  approvedScreenKeys?: readonly MountedScreenKey[];
}

/**
 * Route-level fail-closed boundary for the new console.
 *
 * The server owns user/org/kill-switch routing. The checked-in exposure
 * manifest independently owns ADR-0025 screen evidence. Both authorities must
 * allow entry; loading, transport errors, malformed responses, legacy routing,
 * and an empty manifest return to the working legacy overview without ever
 * mounting the console.
 */
export function ConsoleRolloutBoundary({
  children,
  approvedScreenKeys = EXPOSED_SCREEN_KEYS,
}: ConsoleRolloutBoundaryProps) {
  const { api } = useAuth();
  const [decision, setDecision] = useState<RolloutDecision>(() => ({
    api,
    approvedScreenKeys,
    state: "checking",
  }));
  const state =
    decision.api === api && decision.approvedScreenKeys === approvedScreenKeys
      ? decision.state
      : "checking";

  useEffect(() => {
    if (approvedScreenKeys.length === 0) return undefined;

    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      if (active) {
        active = false;
        setDecision({ api, approvedScreenKeys, state: "denied" });
      }
      controller.abort();
    }, ROLLOUT_AUTHORITY_TIMEOUT_MS);
    void api
      .GET("/api/v1/console/rollout", { signal: controller.signal })
      .then((response) => {
        if (!active) return;
        const status = response.data;
        setDecision({
          api,
          approvedScreenKeys,
          state:
            approvedScreenKeys.length > 0 &&
            isConsoleRolloutStatus(status) &&
            isNewConsoleRouteEffective(status)
              ? "allowed"
              : "denied",
        });
      })
      .catch(() => {
        if (active) setDecision({ api, approvedScreenKeys, state: "denied" });
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [api, approvedScreenKeys]);

  if (approvedScreenKeys.length === 0 || state === "denied") {
    return <Navigate to="/overview" replace />;
  }
  if (state === "checking") {
    return (
      <div
        role="status"
        aria-label={ko.console.rollout.checking}
        style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}
      >
        {ko.console.rollout.checking}
      </div>
    );
  }
  return children;
}
