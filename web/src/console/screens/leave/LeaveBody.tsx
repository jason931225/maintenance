import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import type { LeaveRequestView } from "../../../api/types";
import { useAuth } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { createLeaveRequest } from "../../leave/api";
import {
  LeaveConsole,
  type LeaveChargeResolutionInput,
  type LeaveCreateInput,
  type LeaveCreateOutcome,
  type LeaveDecideOutcome,
  type LeavePromotionOutcome,
  type LeaveResolveOutcome,
} from "../../leave/LeaveConsole";
import { rosterToLedgerRow, type LeaveLedgerRow } from "../../leave/model";
import {
  DENY_ALL_PROJECTION,
  fetchAuthzProjection,
  gateAllows,
  type AuthzProjection,
} from "../../policy/authz";
import "../../tokens.css";

type ReadState = "loading" | "idle" | "error";

function bodyStrings(): {
  loading: string;
  loadFailed: string;
  retry: string;
  managedLoadFailed: string;
} {
  const leave = (ko.console as { leave?: { wire?: Record<string, unknown> } })
    .leave;
  const pick = (key: string, fallback: string) => {
    const value = leave?.wire?.[key];
    return typeof value === "string" ? value : fallback;
  };
  return {
    loading: pick("loading", "Loading leave data…"),
    loadFailed: pick("loadFailed", "Could not load your leave data."),
    retry: pick("retry", "Retry"),
    managedLoadFailed: pick(
      "managedLoadFailed",
      "Your leave data is available, but managed leave data could not be loaded.",
    ),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "error" in error) {
    const nested = (error as { error?: unknown }).error;
    if (nested && typeof nested === "object" && "message" in nested) {
      const message = (nested as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}

const bodyStyle: CSSProperties = {
  height: "100%",
  overflowY: "auto",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
};

const errorPanelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  justifyItems: "start",
  padding: "var(--sp-card-y) var(--sp-6)",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const retryStyle: CSSProperties = {
  minHeight: 44,
  padding: "0 var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--muted)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  cursor: "pointer",
};

interface LeaveAuthority {
  api: ReturnType<typeof useAuth>["api"];
  bearer: string | undefined;
  key: string;
  controller: AbortController;
}

export function LeaveBody() {
  const { api, session } = useAuth();
  const authority: LeaveAuthority = useMemo(
    () => ({
      api,
      bearer: session?.access_token,
      key: [
        session?.org_id,
        session?.user_id,
        session?.client_session_incarnation,
        session?.access_token,
      ].join(":"),
      controller: new AbortController(),
    }),
    [
      api,
      session?.access_token,
      session?.client_session_incarnation,
      session?.org_id,
      session?.user_id,
    ],
  );

  return (
    <LeaveAuthorityBody
      key={authority.key}
      authority={authority}
      selfUserId={session?.user_id}
    />
  );
}

function LeaveAuthorityBody({
  authority,
  selfUserId,
}: {
  authority: LeaveAuthority;
  selfUserId: string | undefined;
}) {
  const S = bodyStrings();
  const [projection, setProjection] =
    useState<AuthzProjection>(DENY_ALL_PROJECTION);
  const [authzReady, setAuthzReady] = useState(false);
  const [selfRequests, setSelfRequests] = useState<LeaveRequestView[]>([]);
  const [selfState, setSelfState] = useState<ReadState>("loading");
  const [selfError, setSelfError] = useState<string>();
  const [managedLedger, setManagedLedger] = useState<LeaveLedgerRow[]>([]);
  const [managedRequests, setManagedRequests] = useState<LeaveRequestView[]>(
    [],
  );
  const [managedState, setManagedState] = useState<ReadState>("idle");

  useLayoutEffect(
    () => () => {
      authority.controller.abort();
    },
    [authority],
  );

  const loadSelf = useCallback(async () => {
    setSelfState("loading");
    setSelfError(undefined);
    const result = await authority.api
      .GET("/api/v1/me/leave", { params: { query: { limit: 200 } } })
      .catch(() => undefined);
    if (authority.controller.signal.aborted) return;
    if (!result?.data) {
      setSelfRequests([]);
      setSelfError(errorMessage(result?.error, S.loadFailed));
      setSelfState("error");
      return;
    }
    setSelfRequests(result.data.requests.items);
    setSelfState("idle");
  }, [S.loadFailed, authority]);

  useEffect(() => {
    void Promise.resolve().then(loadSelf);
    void fetchAuthzProjection(
      authority.bearer,
      authority.controller.signal,
    ).then((next) => {
      if (authority.controller.signal.aborted) return;
      setProjection(next ?? DENY_ALL_PROJECTION);
      setAuthzReady(true);
    });
  }, [authority, loadSelf]);

  const canReadManaged =
    authzReady &&
    gateAllows(projection, { feature: "employee_directory_read" });

  const loadManaged = useCallback(async () => {
    if (!canReadManaged) return;
    setManagedState("loading");
    const [balances, page] = await Promise.all([
      authority.api.GET("/api/v1/leave/balances", {}).catch(() => undefined),
      authority.api
        .GET("/api/v1/leave/requests", { params: { query: { limit: 200 } } })
        .catch(() => undefined),
    ]);
    if (authority.controller.signal.aborted) return;
    if (!balances?.data || !page?.data) {
      setManagedLedger([]);
      setManagedRequests([]);
      setManagedState("error");
      return;
    }
    setManagedLedger(balances.data.items.map(rosterToLedgerRow));
    setManagedRequests(page.data.items);
    setManagedState("idle");
  }, [authority, canReadManaged]);

  useEffect(() => {
    if (canReadManaged) void Promise.resolve().then(loadManaged);
  }, [canReadManaged, loadManaged]);

  const decide = useCallback(
    async (
      requestId: string,
      expectedVersion: number,
      decision: "approve" | "return" | "reject",
      comment?: string,
    ): Promise<LeaveDecideOutcome> => {
      const result = await authority.api.POST(
        "/api/v1/leave/requests/{id}/decide",
        {
          params: { path: { id: requestId } },
          body: { expected_version: expectedVersion, decision, comment },
        },
      );
      if (authority.controller.signal.aborted) return { ok: false };
      if (!result.data) return { ok: false, error: result.error };
      const decided = result.data;
      setManagedRequests((current) =>
        current.map((request) =>
          request.id === requestId ? decided : request,
        ),
      );
      setSelfRequests((current) =>
        current.map((request) =>
          request.id === requestId ? decided : request,
        ),
      );
      return { ok: true };
    },
    [authority],
  );

  const resolveCharge = useCallback(
    async (
      requestId: string,
      input: LeaveChargeResolutionInput,
    ): Promise<LeaveResolveOutcome> => {
      const result = await authority.api.POST(
        "/api/v1/leave/requests/{id}/charge-resolution",
        {
          params: { path: { id: requestId } },
          body: input,
        },
      );
      if (authority.controller.signal.aborted) return { ok: false };
      if (!result.data) return { ok: false, error: result.error };
      const resolved = result.data;
      const apply = (current: LeaveRequestView[]) =>
        current.map((request) =>
          request.id === requestId
            ? {
                ...request,
                request_version: resolved.request_version,
                charge_units: resolved.charge_units,
                charge_state: resolved.charge_state,
                charge_version: resolved.charge_version,
                charge_digest: resolved.server_digest,
              }
            : request,
        );
      setManagedRequests(apply);
      setSelfRequests(apply);
      return { ok: true };
    },
    [authority],
  );

  const createRequest = useCallback(
    async (input: LeaveCreateInput): Promise<LeaveCreateOutcome> => {
      const result = await createLeaveRequest(authority.api, input);
      if (authority.controller.signal.aborted) return { ok: false };
      if (!result.ok || !result.data) return { ok: false, error: result.error };
      const created = result.data;
      setSelfRequests((current) => [created, ...current]);
      if (canReadManaged)
        setManagedRequests((current) => [created, ...current]);
      return { ok: true };
    },
    [authority, canReadManaged],
  );

  const pushPromotion = useCallback(
    async (payload: {
      branchId: string;
      targetUserId: string;
      targetEmployeeId: string;
      targetName: string;
      round: 1 | 2;
      unusedDays: number;
    }): Promise<LeavePromotionOutcome> => {
      const result = await authority.api.POST("/api/v1/leave/promotions", {
        body: {
          branch_id: payload.branchId,
          target_user_id: payload.targetUserId,
          target_employee_id: payload.targetEmployeeId,
          target_name: payload.targetName,
          round: payload.round,
          unused_days: payload.unusedDays,
        },
      });
      if (authority.controller.signal.aborted) return { ok: false };
      if (!result.data) return { ok: false, error: result.error };
      return { ok: true, push: result.data };
    },
    [authority],
  );

  const canManageBranch = useCallback(
    (branchId: string) =>
      authzReady &&
      gateAllows(projection, {
        feature: "employee_directory_manage",
        branch: branchId,
      }),
    [authzReady, projection],
  );

  return (
    <div className="console" data-cshell-screen-body="leave" style={bodyStyle}>
      {selfState === "loading" ? (
        <p style={{ color: "var(--steel)", fontFamily: "var(--font-sans)" }}>
          {S.loading}
        </p>
      ) : selfState === "error" ? (
        <section style={errorPanelStyle} role="alert">
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-body)",
              color: "var(--steel)",
            }}
          >
            {selfError ?? S.loadFailed}
          </p>
          <button
            type="button"
            style={retryStyle}
            onClick={() => {
              void loadSelf();
            }}
          >
            {S.retry}
          </button>
        </section>
      ) : (
        <>
          {managedState === "error" ? (
            <section style={errorPanelStyle} role="alert">
              <p style={{ margin: 0 }}>{S.managedLoadFailed}</p>
              <button
                type="button"
                style={retryStyle}
                onClick={() => {
                  void loadManaged();
                }}
              >
                {S.retry}
              </button>
            </section>
          ) : null}
          <LeaveConsole
            key={authority.key}
            ledger={managedLedger}
            requests={managedRequests}
            selfRequests={selfRequests}
            selfUserId={selfUserId}
            canReadManaged={canReadManaged}
            canManageBranch={canManageBranch}
            decide={decide}
            resolveCharge={resolveCharge}
            createRequest={createRequest}
            pushPromotion={pushPromotion}
          />
        </>
      )}
    </div>
  );
}
