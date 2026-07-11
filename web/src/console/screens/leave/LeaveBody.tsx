import { useCallback, useEffect, useState, type CSSProperties } from "react";

import type { LeaveRequestView } from "../../../api/types";
import { useAuth } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { LeaveConsole, type LeaveDecideOutcome, type LeavePromotionOutcome } from "../../leave/LeaveConsole";
import { LEAVE_ACTIONS, rosterToLedgerRow, type LeaveLedgerRow } from "../../leave/model";
import { BulkPolicyGateProvider } from "../../policy";
import "../../tokens.css";

const LEAVE_GATE_ACTIONS = Object.values(LEAVE_ACTIONS);

/**
 * 연차 screen body (ConsoleShell nav "leave") — composes the existing,
 * fully-wired `console/leave/LeaveConsole` (§4-18: no rebuild) into the
 * console shell's screen slot. Self-contained: owns the roster/queue fetch
 * (GET /api/v1/leave/balances + /leave/requests), the roster→ledger mapping
 * (`rosterToLedgerRow`, model.ts), and the decide/§61-push REST calls
 * LeaveConsole's props contract expects. This is also the real Phase-C PBAC
 * wire model.ts flagged as wire-pending: `BulkPolicyGateProvider` replaces
 * the local `LEAVE_RUNTIME_GATE` allow-list stub with real
 * POST /api/v1/policy/authorize/bulk decisions (same upgrade AutomateBody
 * made for AUTOMATE_RUNTIME_GATE). The serial wire mounts `<LeaveBody />`
 * with no props.
 */

type ReadState = "loading" | "idle" | "error";

// The body's own loading/error/retry copy — read defensively off the
// already-wired ko.console.leave, with an English fallback until the
// koManifest lands `wire.{loading,loadFailed,retry}` (this lane must not edit
// ko.ts — same defensive-pick pattern as DashboardBody).
function bodyStrings(): { loading: string; loadFailed: string; retry: string } {
  const leave = (ko.console as { leave?: { wire?: Record<string, unknown> } }).leave;
  const pick = (key: string, fallback: string) => {
    const value = leave?.wire?.[key];
    return typeof value === "string" ? value : fallback;
  };
  return {
    loading: pick("loading", "Loading leave data…"),
    loadFailed: pick("loadFailed", "Could not load leave data."),
    retry: pick("retry", "Retry"),
  };
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

export function LeaveBody() {
  const { api, session } = useAuth();
  const S = bodyStrings();
  const [ledger, setLedger] = useState<LeaveLedgerRow[]>([]);
  const [requests, setRequests] = useState<LeaveRequestView[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");

  const load = useCallback(async () => {
    setReadState("loading");
    const [balances, page] = await Promise.all([
      api.GET("/api/v1/leave/balances", {}).catch(() => undefined),
      api.GET("/api/v1/leave/requests", { params: { query: { limit: 200 } } }).catch(() => undefined),
    ]);
    if (!balances?.data || !page?.data) {
      setReadState("error");
      return;
    }
    setLedger(balances.data.items.map(rosterToLedgerRow));
    setRequests(page.data.items);
    setReadState("idle");
  }, [api]);

  useEffect(() => {
    // Defer out of the synchronous effect body so the initial setState(loading)
    // does not cascade a render (react-hooks/set-state-in-effect).
    void Promise.resolve().then(load);
  }, [load]);

  const decide = useCallback(
    async (requestId: string, decision: "approve" | "reject", comment?: string): Promise<LeaveDecideOutcome> => {
      const result = await api.POST("/api/v1/leave/requests/{id}/decide", {
        params: { path: { id: requestId } },
        body: { decision, comment },
      });
      if (!result.data) return { ok: false, error: result.error };
      const decided = result.data;
      setRequests((current) => current.map((r) => (r.id === requestId ? decided : r)));
      return { ok: true };
    },
    [api],
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
      const result = await api.POST("/api/v1/leave/promotions", {
        body: {
          branch_id: payload.branchId,
          target_user_id: payload.targetUserId,
          target_employee_id: payload.targetEmployeeId,
          target_name: payload.targetName,
          round: payload.round,
          unused_days: payload.unusedDays,
        },
      });
      if (!result.data) return { ok: false, error: result.error };
      return { ok: true, push: result.data };
    },
    [api],
  );

  return (
    <div className="console" data-cshell-screen-body="leave" style={bodyStyle}>
      {readState === "error" ? (
        <section style={errorPanelStyle} role="alert">
          <p style={{ margin: 0, fontSize: "var(--text-body)", color: "var(--steel)" }}>
            {S.loadFailed}
          </p>
          <button
            type="button"
            style={retryStyle}
            onClick={() => {
              void load();
            }}
          >
            {S.retry}
          </button>
        </section>
      ) : readState === "loading" ? (
        <p style={{ color: "var(--steel)", fontFamily: "var(--font-sans)" }}>{S.loading}</p>
      ) : (
        <BulkPolicyGateProvider actions={LEAVE_GATE_ACTIONS}>
          <LeaveConsole
            ledger={ledger}
            requests={requests}
            selfUserId={session?.user_id}
            decide={decide}
            pushPromotion={pushPromotion}
          />
        </BulkPolicyGateProvider>
      )}
    </div>
  );
}
