import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { listAccountDrillEntries, type AccountDrillEntry } from "./financeApi";

const copy = ko.console.modules.finance.accountLedger;
const columns = ko.console.modules.finance.columns;
const detail = ko.console.modules.finance.detail;

const wonFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" });

const panelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  padding: "var(--sp-4)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
};

const headingStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse" };
const cellStyle: CSSProperties = {
  padding: "var(--sp-3)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  textAlign: "left",
  verticalAlign: "top",
};
const codeStyle: CSSProperties = { fontFamily: "var(--font-mono)", fontWeight: "var(--fw-strong)", whiteSpace: "nowrap" };

function formatWon(amount: number): string {
  return `₩${wonFormatter.format(amount)}`;
}

function formatEntryAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function sourceIdentity(entry: AccountDrillEntry): string {
  if (entry.source_object_type && entry.source_object_id) {
    return `${entry.source_object_type} / ${entry.source_object_id}`;
  }
  return copy.sourceAbsent;
}

type LedgerState =
  | { kind: "loading" }
  | { kind: "ready"; entries: AccountDrillEntry[] }
  | { kind: "denied" }
  | { kind: "error" };

/** Finance-only account-code drill panel. Each selection owns an AbortController
 * and monotonically increasing epoch so a late response cannot cross account
 * selection or the parent authority-key remount fence. */
export function AccountLedgerDrill({
  api,
  accountCode,
  onClose,
}: {
  api: ConsoleApiClient;
  accountCode: string;
  onClose: () => void;
}) {
  const requestEpoch = useRef(0);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [state, setState] = useState<LedgerState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    void listAccountDrillEntries(api, accountCode, controller.signal)
      .then((entries) => {
        if (controller.signal.aborted || epoch !== requestEpoch.current) return;
        setState({ kind: "ready", entries });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || epoch !== requestEpoch.current) return;
        if (error instanceof ApiCallError && (error.status === 401 || error.status === 403)) {
          setState({ kind: "denied" });
          return;
        }
        setState({ kind: "error" });
      });
    return () => {
      controller.abort();
    };
  }, [accountCode, api, retryEpoch]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setRetryEpoch((value) => value + 1);
  }, []);

  return (
    <section aria-label={copy.title(accountCode)} role="region" style={panelStyle}>
      <div style={headingStyle}>
        <span style={codeStyle}>{copy.title(accountCode)}</span>
        <button type="button" onClick={onClose} style={buttonStyle}>{copy.close}</button>
      </div>
      {state.kind === "loading" ? <StatusChip role="status" tone="info">{copy.loading}</StatusChip> : null}
      {state.kind === "denied" ? <StatusChip role="alert" tone="danger">{copy.denied}</StatusChip> : null}
      {state.kind === "error" ? (
        <div role="alert" style={headingStyle}>
          <StatusChip tone="danger">{copy.failed}</StatusChip>
          <button type="button" onClick={retry} style={buttonStyle}>{ko.page.retry}</button>
        </div>
      ) : null}
      {state.kind === "ready" && state.entries.length === 0 ? <StatusChip tone="neutral">{copy.empty}</StatusChip> : null}
      {state.kind === "ready" && state.entries.length > 0 ? (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th scope="col" style={cellStyle}>{columns.code}</th>
                <th scope="col" style={cellStyle}>{detail.balanceCheck}</th>
                <th scope="col" style={cellStyle}>{columns.amount}</th>
                <th scope="col" style={cellStyle}>{columns.source}</th>
                <th scope="col" style={cellStyle}>{detail.postedAt}</th>
              </tr>
            </thead>
            <tbody>
              {state.entries.map((entry) => (
                <tr key={entry.line_id}>
                  <td style={{ ...cellStyle, ...codeStyle }}>{entry.voucher_no}</td>
                  <td style={cellStyle}>{entry.side === "DEBIT" ? detail.totalDebit : detail.totalCredit}</td>
                  <td style={{ ...cellStyle, ...codeStyle }}>{formatWon(entry.amount_won)}</td>
                  <td style={{ ...cellStyle, ...codeStyle }}>{sourceIdentity(entry)}</td>
                  <td style={{ ...cellStyle, ...codeStyle }}>{formatEntryAt(entry.entry_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
