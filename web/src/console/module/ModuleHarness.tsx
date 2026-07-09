import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";

import { useAuth, type AuthSession } from "../../context/auth";
import { PolicyGateProvider } from "../policy/PolicyGated";
import type { PolicyDecider } from "../policy/usePolicyGate";
import { ModuleScreen, type ModuleLoadState } from "./ModuleScreen";
import type { ModuleConfig } from "./config";
import { supportTicketModuleConfig, workOrderModuleConfig } from "./moduleConfigs";
import "../tokens.css";

/**
 * Live-read demo mount for the generic module template (charter §3 P0.4:
 * "prove the template renders real data end to end"). Standalone dev harness at
 * `/console-dev/module` — NOT a product surface (integration into the P0.1
 * shell + window engine comes later). `?config=support` switches to the second
 * proof config through the SAME `ModuleScreen` with zero component changes.
 *
 * Every affordance is gated through the shared PolicyGated primitive; the
 * decider here is an advisory UI projection from the session (admins allow-all,
 * others need an explicit feature grant). This mirrors deny-by-omission for the
 * UI only — the backend RLS/PBAC layer is the real authority. When the sibling
 * policy lane merges, swap this decider for its session→decision hook.
 */

// A ModuleConfig for any Row — the harness only calls the config's own
// (Row-closed) methods, so this existential erasure is safe.
type AnyConfig = ModuleConfig<never>;

const CONFIGS: Record<string, AnyConfig> = {
  workOrder: workOrderModuleConfig as unknown as AnyConfig,
  support: supportTicketModuleConfig as unknown as AnyConfig,
};

function sessionDecider(session: AuthSession | undefined): PolicyDecider {
  const roles = session?.roles ?? [];
  const admin = roles.includes("ADMIN") || roles.includes("SUPER_ADMIN");
  const grants = new Set(session?.feature_grants ?? []);
  return (action) => admin || grants.has(action);
}

const frameStyle: CSSProperties = {
  height: "100dvh",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

export function ModuleHarness() {
  const { api, session } = useAuth();
  const [params] = useSearchParams();
  const config = CONFIGS[params.get("config") ?? "workOrder"] ?? workOrderModuleConfig;

  const [rows, setRows] = useState<never[]>([]);
  const [loadState, setLoadState] = useState<ModuleLoadState>("loading");
  const [toast, setToast] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const guard = { live: true };
    void (async () => {
      setLoadState("loading");
      try {
        const loaded = await config.load(api);
        if (!guard.live) return;
        setRows(loaded);
        setLoadState("idle");
      } catch {
        if (!guard.live) return;
        setRows([]);
        setLoadState("error");
      }
    })();
    return () => {
      guard.live = false;
    };
  }, [config, api, reloadKey]);

  const decide = useMemo(() => sessionDecider(session), [session]);
  const onRetry = useCallback(() => { setReloadKey((k) => k + 1); }, []);
  const onToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => { setToast(null); }, 3000);
  }, []);

  return (
    <div style={frameStyle}>
      <PolicyGateProvider decide={decide}>
        <ModuleScreen
          config={config}
          rows={rows}
          loadState={loadState}
          api={api}
          onRetry={onRetry}
          onToast={onToast}
        />
      </PolicyGateProvider>
      {toast ? (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: "var(--sp-4)",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "var(--sp-2) var(--sp-4)",
            borderRadius: "var(--radius-md)",
            background: "var(--ink)",
            color: "var(--canvas)",
            fontSize: "var(--text-sm)",
            boxShadow: "var(--shadow-pop)",
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

export default ModuleHarness;
