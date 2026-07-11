import { useCallback, useEffect, useState, type CSSProperties } from "react";

import type { KpiReport, OpsSummary } from "../../../api/types";
import { useAuth } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { DashboardScreen } from "../../dashboard";
import { ROLES } from "../../shell/nav";
import "../../tokens.css";

/**
 * 대시보드 screen body — composes the existing honest DashboardScreen (§4-11
 * stat strip, §4-24 honest charts, PBAC-relative scope segments) into the
 * console shell's screen slot. Self-contained: it owns the KPI/ops fetch that
 * KpiPage used to drive, so the serial wire mounts `<DashboardBody />` with no
 * props. Sections of the reference with no backing API (인건비 추이 trend,
 * 계약 수익성, 인사이트 AN-*) stay omitted, never placeholdered (§4-25-⑥) —
 * they live in DashboardScreen's honest-omission contract, not here.
 */

type ReadState = "loading" | "idle" | "error";

// Backend OpsDashboardRead is ADMIN/SUPER_ADMIN only (EXECUTIVE holds KpiRead
// but is denied ops). Mirror it so a KPI-only viewer never fires an ops request
// that would 403 and trip the console's strict logged-error guard.
const OPS_ROLES: readonly string[] = [ROLES.ADMIN, ROLES.SUPER_ADMIN];

// The body's own error/retry copy — read defensively off the already-wired
// ko.console.dashboard, with an English fallback until the koManifest lands the
// two keys (this lane must not edit ko.ts). check-ui-strings forbids Hangul in
// lane files, so the fallbacks stay English.
function bodyStrings(): { errorReason: string; retry: string } {
  const dash = (ko.console as { dashboard?: Record<string, unknown> }).dashboard;
  const pick = (key: string, fallback: string) => {
    const value = dash?.[key];
    return typeof value === "string" ? value : fallback;
  };
  return {
    errorReason: pick("errorReason", "Could not load metrics"),
    retry: pick("retry", "Retry"),
  };
}

/** Current month (진행) range — the KPI report's default period segment. */
function currentMonthPeriod(now = new Date()): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  return `${iso(start)}..${iso(end)}`;
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

export function DashboardBody() {
  const { api, session } = useAuth();
  const S = bodyStrings();
  const [report, setReport] = useState<KpiReport>();
  const [opsSummary, setOpsSummary] = useState<OpsSummary>();
  const [period, setPeriod] = useState(currentMonthPeriod);
  const [readState, setReadState] = useState<ReadState>("loading");

  const canReadOps = (session?.roles ?? []).some((role) =>
    OPS_ROLES.includes(role),
  );

  const load = useCallback(
    async (nextPeriod: string) => {
      setReadState("loading");
      const [kpiResponse, opsResponse] = await Promise.all([
        api
          .GET("/api/v1/kpi", { params: { query: { period: nextPeriod } } })
          .catch(() => undefined),
        // Ops stats are additive: a KPI-only viewer simply gets no ops stats in
        // the strip (honest omission). Only ops-authorized viewers fire it.
        canReadOps
          ? api.GET("/api/v1/ops/summary", {}).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (!kpiResponse?.data) {
        setReadState("error");
        return;
      }
      setReport(kpiResponse.data);
      setOpsSummary(opsResponse?.data);
      setReadState("idle");
    },
    [api, canReadOps],
  );

  useEffect(() => {
    // Defer out of the synchronous effect body so the initial setState(loading)
    // does not cascade a render (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => load(period));
  }, [load, period]);

  return (
    <div className="console" data-cshell-screen-body="dashboard" style={bodyStyle}>
      {readState === "error" ? (
        <section style={errorPanelStyle} role="alert">
          <p style={{ margin: 0, fontSize: "var(--text-body)", color: "var(--steel)" }}>
            {S.errorReason}
          </p>
          <button
            type="button"
            style={retryStyle}
            onClick={() => {
              void load(period);
            }}
          >
            {S.retry}
          </button>
        </section>
      ) : (
        <DashboardScreen
          report={report}
          opsSummary={opsSummary}
          period={period}
          isLoading={readState === "loading"}
          onPeriodChange={setPeriod}
        />
      )}
    </div>
  );
}
