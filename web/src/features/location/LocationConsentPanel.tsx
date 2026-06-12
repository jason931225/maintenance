import { Download, Power, PowerOff, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  LocationConsentLedgerPage,
  LocationConsentStatus,
  TokenPairResponse,
} from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";

interface LocationConsentPanelProps {
  api: ConsoleApiClient;
  branchId: string;
  session?: TokenPairResponse;
}

type MutatingAction = "grant" | "suspend" | "resume" | "withdraw";

export function LocationConsentPanel({
  api,
  branchId,
  session,
}: LocationConsentPanelProps) {
  const [status, setStatus] = useState<LocationConsentStatus>();
  const [ledger, setLedger] = useState<LocationConsentLedgerPage>();
  const [isLoading, setIsLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<MutatingAction>();
  const [error, setError] = useState(false);

  const canCallApi = Boolean(session);
  const state = status?.state ?? "NO_RECORD";
  const mayCollect = status?.may_collect ?? false;
  const actionLabels = ko.location.actions;
  const stateLabels = ko.location.states;
  const statusTone = mayCollect
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : "border-slate-200 bg-slate-50 text-slate-800";
  const latestLedger = useMemo(
    () => ledger?.items.slice(0, 4) ?? [],
    [ledger?.items],
  );

  const load = useCallback(async () => {
    if (!session) {
      setStatus(undefined);
      setLedger(undefined);
      return;
    }

    setIsLoading(true);
    setError(false);
    const [statusResponse, ledgerResponse] = await Promise.all([
      api.GET("/api/v1/location-consent/status", {
        params: { query: { branch_id: branchId } },
      }),
      api.GET("/api/v1/location-consents/ledger", {
        params: { query: { branch_id: branchId, limit: 10, offset: 0 } },
      }),
    ]).catch(() => [undefined, undefined] as const);

    if (!statusResponse?.data) {
      setError(true);
      setIsLoading(false);
      return;
    }

    setStatus(statusResponse.data);
    if (ledgerResponse.data) {
      setLedger(ledgerResponse.data);
    }
    setIsLoading(false);
  }, [api, branchId, session]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function transition(action: MutatingAction) {
    setBusyAction(action);
    setError(false);
    const body = { branch_id: branchId };
    const response =
      action === "grant"
        ? await api.POST("/api/v1/location-consent/grant", { body })
        : action === "suspend"
          ? await api.POST("/api/v1/location-consent/suspend", { body })
          : action === "resume"
            ? await api.POST("/api/v1/location-consent/resume", { body })
            : await api.POST("/api/v1/location-consent/withdraw", { body });

    if (!response.data) {
      setError(true);
      setBusyAction(undefined);
      return;
    }

    setStatus(response.data);
    setBusyAction(undefined);
    void load();
  }

  async function exportCsv() {
    const response = await api.GET("/api/v1/location-consents/ledger.csv", {
      params: { query: { branch_id: branchId, limit: 100, offset: 0 } },
      parseAs: "text",
    });
    if (!response.data) {
      setError(true);
      return;
    }
    downloadCsv(response.data);
  }

  return (
    <Card aria-labelledby="location-consent-title" className="grid gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2
            id="location-consent-title"
            className="text-base font-bold text-slate-950"
          >
            {ko.location.title}
          </h2>
          <p className="text-sm text-slate-600">{ko.location.subtitle}</p>
        </div>
        <span
          className={`shrink-0 rounded-md border px-2 py-1 text-xs font-bold ${statusTone}`}
        >
          {stateLabels[state]}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={!canCallApi || state === "GRANTED" || busyAction === "grant"}
          type="button"
          onClick={() => void transition("grant")}
        >
          <ShieldCheck aria-hidden="true" className="size-4" />
          {state === "WITHDRAWN"
            ? actionLabels.regain
            : actionLabels.grant}
        </Button>
        <Button
          disabled={!canCallApi || state !== "GRANTED" || busyAction === "suspend"}
          type="button"
          variant="secondary"
          onClick={() => void transition("suspend")}
        >
          <PowerOff aria-hidden="true" className="size-4" />
          {actionLabels.suspend}
        </Button>
        <Button
          disabled={!canCallApi || state !== "SUSPENDED" || busyAction === "resume"}
          type="button"
          variant="secondary"
          onClick={() => void transition("resume")}
        >
          <Power aria-hidden="true" className="size-4" />
          {actionLabels.resume}
        </Button>
        <Button
          disabled={
            !canCallApi ||
            (state !== "GRANTED" && state !== "SUSPENDED") ||
            busyAction === "withdraw"
          }
          type="button"
          variant="destructive"
          onClick={() => void transition("withdraw")}
        >
          <PowerOff aria-hidden="true" className="size-4" />
          {actionLabels.withdraw}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canCallApi || isLoading}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void load()}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {ko.location.refresh}
        </Button>
        <Button
          disabled={!canCallApi}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void exportCsv()}
        >
          <Download aria-hidden="true" className="size-4" />
          {ko.location.exportCsv}
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-slate-500">{ko.location.collection}</dt>
          <dd className="font-semibold text-slate-950">
            {mayCollect ? ko.common.yes : ko.common.no}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">{ko.location.updatedAt}</dt>
          <dd className="font-semibold text-slate-950">
            {formatTimestamp(status?.updated_at)}
          </dd>
        </div>
      </dl>

      {latestLedger.length > 0 ? (
        <ul className="grid gap-2 text-sm">
          {latestLedger.map((entry) => (
            <li
              className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2"
              key={entry.id}
            >
              <span className="font-medium text-slate-800">
                {actionLabels[ledgerActionKey(entry.action)]}
              </span>
              <time className="text-xs text-slate-500">
                {formatTimestamp(entry.occurred_at)}
              </time>
            </li>
          ))}
        </ul>
      ) : null}

      {!session ? (
        <p className="text-sm text-slate-600">{ko.location.sessionMissing}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.location.loadFailed}
        </p>
      ) : null}
    </Card>
  );
}

function ledgerActionKey(
  action: string,
): Extract<MutatingAction, "grant" | "suspend" | "resume" | "withdraw"> {
  if (action === "consent.suspend") {
    return "suspend";
  }
  if (action === "consent.resume") {
    return "resume";
  }
  if (action === "consent.withdraw") {
    return "withdraw";
  }
  return "grant";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return ko.common.notSet;
  }
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function downloadCsv(csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "location-consent-ledger.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}
