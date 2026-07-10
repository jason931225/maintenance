import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import {
  CONFIG_CONSOLE_ACTIONS,
  DashboardEditor,
  fetchOntInstances,
  fetchOntObjectTypes,
  type OntInstanceRow,
  type OntObjectTypeDef,
} from "../console/configconsole";
import { PolicyGateProvider, type PolicyGate } from "../console/policy";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

type ReadState = "loading" | "idle" | "error";

// wire-pending: Phase C — decisions come from /policy/authorize (arch §5c);
// until then the console surface is gated by this local allow-list.
const CONFIG_CONSOLE_GATE_ACTIONS: ReadonlySet<string> = new Set(
  Object.values(CONFIG_CONSOLE_ACTIONS),
);
const CONFIG_CONSOLE_GATE: PolicyGate = {
  can: (action) => CONFIG_CONSOLE_GATE_ACTIONS.has(action),
};

/**
 * Config Console / dashboard editor (분석 › 구성 콘솔, DESIGN §19): a 4-slot
 * dashboard grid over a widget palette, held as one serializable config doc —
 * 저장 = personal view (§3.9.0-①), 팀 배포 — 결재 = shared-layout approval.
 * Widget numbers aggregate the real ontology instance rows
 * (GET /api/v1/ontology/instances?type=) over the tenant registry.
 */
export function ConfigConsolePage() {
  const { api } = useAuth();
  const [readState, setReadState] = useState<ReadState>("loading");
  const [registry, setRegistry] = useState<readonly OntObjectTypeDef[]>([]);
  const [rows, setRows] = useState<readonly OntInstanceRow[]>([]);

  const load = useCallback(async () => {
    setReadState("loading");
    try {
      const types = await fetchOntObjectTypes(api);
      const instances = await fetchOntInstances(api, types);
      setRegistry(types);
      setRows(instances);
      setReadState("idle");
    } catch {
      setReadState("error");
    }
  }, [api]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [load]);

  return (
    <>
      <PageHeader
        title={ko.nav["config-console"]}
        actions={
          <RefreshButton
            onClick={() => {
              void load();
            }}
            isLoading={readState === "loading"}
          />
        }
      />
      {readState === "error" ? (
        <PageError
          onRetry={() => {
            void load();
          }}
        />
      ) : readState === "loading" ? (
        <SkeletonTable rows={4} cols={2} />
      ) : (
        <PolicyGateProvider gate={CONFIG_CONSOLE_GATE}>
          <DashboardEditor registry={registry} rows={rows} />
        </PolicyGateProvider>
      )}
    </>
  );
}
