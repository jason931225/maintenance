// 레인1 leave 카드 존 — 연차관리 REAL-wired surface (design 다음 #1, verdict-R1
// fixes). Grammar: 1-row drillable stat bar (§4-11), 2-col split ≥1280
// (roster + decision queue, leave.css), usage bars via console/charts
// honestScale, 팀 결재함 (decide, SoD: no self-approval + backend 403
// surfaced), 사용촉진 발송 (근로기준법 §61, real POST /leave/promotions),
// 인원별 연차 원장. Every roster row is an objDrag source and its code opens
// the ObjectCard as the right pin (§4.7-3); request rows carry no code yet
// (no registered object prefix until the AP- submittable binds — no
// fabricated codes, see model.ts header). Personas (§4-25-⑦):
// 본인/팀장/HR 전담/관리자 — sections deny-by-omission via PolicyGated.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import type { LeaveRequestView, LeaveStatutoryPushView } from "../../api/types";
import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { objectCardWindowEntry } from "../objectcard";
import { PolicyGated } from "../policy";
import "../tokens.css";
import "./leave.css";
import { objDrag, useOptionalWindowManager } from "../window";
import {
  dayLabel,
  isHalfDay,
  LEAVE_ACTIONS,
  LEAVE_REASONS,
  leaveStrings,
  ledgerDescriptor,
  requestDays,
  rowBurnRate,
  type LeaveLedgerRow,
  type LeaveReason,
  type LedgerFilter,
  type LeaveRosterTone,
} from "./model";

// ko.console.leave.ledger.columns.burnRate and ko.console.leave.promotion.{
// queueTitle, unusedLabel(days), emptyQueue} are now real (wired in ko.ts,
// serial wire round 4). English fallbacks below only guard a future ko.ts
// regression (same defensive-pick pattern as LeaveBody/PolicyBody).
function densityStrings(): {
  burnRateColumn: string;
  queueTitle: string;
  unusedLabel: (days: string) => string;
  emptyQueue: string;
} {
  const leave = ko.console.leave as unknown as {
    ledger?: { columns?: Record<string, unknown> };
    promotion?: Record<string, unknown>;
  };
  const columns = leave.ledger?.columns;
  const promotion = leave.promotion;
  const pickStr = (value: unknown, fallback: string): string =>
    typeof value === "string" ? value : fallback;
  const unusedLabel =
    typeof promotion?.unusedLabel === "function"
      ? (promotion.unusedLabel as (days: string) => string)
      : (days: string) => `${days} unused`;
  return {
    burnRateColumn: pickStr(columns?.burnRate, "Burn rate"),
    queueTitle: pickStr(promotion?.queueTitle, "Leave usage prompts"),
    unusedLabel,
    emptyQueue: pickStr(promotion?.emptyQueue, "No promotion targets"),
  };
}

// ko.console.leave.self.{submit,submitting,submitFailed,submitted} land via the
// koManifest (this lane cannot edit ko.ts). English fallbacks keep the real
// inline submit working now — same defensive-pick pattern as densityStrings, and
// non-Hangul so check-ui-strings stays green on this lane file.
function submitStrings(): {
  submit: string;
  submitting: string;
  submitFailed: string;
  submitted: string;
} {
  const self = (ko.console.leave as unknown as { self?: Record<string, unknown> }).self;
  const pick = (key: string, fallback: string): string => {
    const value = self?.[key];
    return typeof value === "string" ? value : fallback;
  };
  return {
    submit: pick("submit", "Submit request"),
    submitting: pick("submitting", "Submitting…"),
    submitFailed: pick("submitFailed", "Could not submit the leave request."),
    submitted: pick("submitted", "Leave request submitted."),
  };
}

// ── Styles (tokens only, 8px grid via --sp-*, §4-25-⑧) ──────────────────────

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const sectionHeadStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

function statButtonStyle(pressed: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--sp-2)",
    minHeight: 44,
    padding: "0 var(--sp-4)",
    borderRadius: "var(--radius-pill)",
    border: `1px solid ${pressed ? "var(--signal)" : "var(--border)"}`,
    background: pressed ? "var(--accent-bg)" : "var(--surface)",
    color: "var(--ink)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--fw-strong)",
    cursor: "pointer",
  };
}

const statLabelStyle: CSSProperties = {
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
  background: "var(--surface)",
};

const codeButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  border: "0",
  background: "transparent",
  color: "var(--ink)",
  padding: "0 var(--sp-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: "1px solid var(--signal)",
  background: "var(--signal)",
};

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  cursor: "not-allowed",
  opacity: 0.5,
};

const formStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  gap: "var(--sp-3)",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const inputStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
};

// Covers ONLY the native date input's empty-blurred placeholder (the browser
// locale's format text), leaving the right-edge calendar-picker indicator
// visible. Opaque surface bg so the native "mm/dd/yyyy" underneath never shows.
const dateHintStyle: CSSProperties = {
  position: "absolute",
  insetBlock: 1,
  insetInlineStart: 1,
  insetInlineEnd: 34,
  display: "flex",
  alignItems: "center",
  paddingInlineStart: "var(--sp-3)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
  color: "var(--faint)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  pointerEvents: "none",
};

// Native `<input type="date">` renders its empty placeholder in the BROWSER's
// locale — "mm/dd/yyyy" under en-US, regardless of the `lang` attribute
// (Chromium ignores content `lang` for date fields; the R9 `lang="ko"` fix did
// not take). Rather than pull in a date-picker library (ponytail: native
// platform feature before a dep), keep the native control — calendar popup, real
// YYYY-MM-DD value, keyboard entry, the 시작일/종료일 label's implicit a11y name —
// and cover only its empty-blurred placeholder with a locale-neutral ISO hint so
// the field never shows English-locale format text. On focus or once filled the
// native control takes over unchanged: zero interaction regression. (No Hangul
// literal — check-ui-strings bans it in lane files and this lane cannot edit
// ko.ts; the visible Korean field label already localizes the control.)
interface KoDateFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The Korean field label (from ko.ts via the caller) — set as the input's
   *  accessible name, since the wrapper span breaks the enclosing <label>'s
   *  implicit control association. */
  ariaLabel: string;
  required?: boolean;
  disabled?: boolean;
}

function KoDateField({ value, onChange, ariaLabel, required, disabled }: KoDateFieldProps) {
  const [focused, setFocused] = useState(false);
  const showHint = !focused && !disabled && value === "";
  return (
    <span style={{ position: "relative", display: "grid" }}>
      <input
        type="date"
        lang="ko"
        aria-label={ariaLabel}
        required={required}
        disabled={disabled}
        value={value}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        style={inputStyle}
      />
      {showHint ? (
        <span aria-hidden="true" style={dateHintStyle}>
          YYYY-MM-DD
        </span>
      ) : null}
    </span>
  );
}

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
};

// Per-row 소진율 meter — same track/fill grammar as charts/HonestMarks'
// HonestBar (§4-18 reuse), sized for an inline table cell rather than a
// drillable chart row.
const meterCellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const meterTrackStyle: CSSProperties = {
  position: "relative",
  display: "block",
  width: 64,
  height: 8,
  background: "var(--muted)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-pill)",
  overflow: "hidden",
  flex: "none",
};

function meterFillStyle(pct: number, tone: LeaveRosterTone): CSSProperties {
  const color = tone === "promote" ? "var(--warn-tx)" : tone === "low" ? "var(--danger-tx)" : "var(--ok-tx)";
  return {
    position: "absolute",
    insetBlock: 0,
    left: 0,
    width: `${String(Math.min(100, Math.max(0, pct)))}%`,
    background: color,
  };
}

const meterValueStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--steel)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const thStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  textAlign: "left",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  verticalAlign: "middle",
  // 직원 코드 + 발생/사용/잔여 cells must stay single-line when the 원장 table's
  // list track shrinks beside an open detail pin; tableWrap overflowX:auto scrolls.
  whiteSpace: "nowrap",
};

const cellMetaStyle: CSSProperties = {
  margin: 0,
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
};

const cellNameStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 66,
  padding: "var(--sp-2) var(--sp-3)",
  width: "100%",
};

// ── Tones ────────────────────────────────────────────────────────────────────

const requestTone = {
  pending: "warn",
  approved: "ok",
  returned: "info",
  rejected: "danger",
} as const;

// ── Errors (backend message surfaced verbatim, §4-10 reason + next action) ──

function errorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null
  ) {
    const inner = (error as { error: { message?: unknown } }).error;
    if (typeof inner.message === "string" && inner.message.trim().length > 0) {
      return inner.message;
    }
  }
  return fallback;
}

// ── Surface ──────────────────────────────────────────────────────────────────

interface RequestForm {
  reason: LeaveReason | "";
  startDate: string;
  endDate: string;
}

const EMPTY_FORM: RequestForm = { reason: "", startDate: "", endDate: "" };

export interface LeaveDecideOutcome {
  ok: boolean;
  error?: unknown;
}

export interface LeavePromotionOutcome {
  ok: boolean;
  push?: LeaveStatutoryPushView;
  error?: unknown;
}

export interface LeaveCreateOutcome {
  ok: boolean;
  error?: unknown;
}

/** What the 본인 form sends: the subject employee + branch are resolved
 *  server-side from the caller, never sent from here. */
export interface LeaveCreateInput {
  leave_type: "annual" | "half_day";
  start_date: string;
  end_date: string;
  reason: string;
}

export interface LeaveConsoleProps {
  ledger: LeaveLedgerRow[];
  /** All requests visible to the caller's scope (every status) — server truth. */
  requests: LeaveRequestView[];
  /** JWT `sub` — used only for the SoD hint + "내 신청" filter, never for authz. */
  selfUserId?: string;
  decide: (requestId: string, decision: "approve" | "return" | "reject", comment?: string) => Promise<LeaveDecideOutcome>;
  /** File a self-service 연차/반차 request (POST /api/v1/leave/requests). */
  createRequest: (input: LeaveCreateInput) => Promise<LeaveCreateOutcome>;
  pushPromotion: (payload: {
    branchId: string;
    targetUserId: string;
    targetEmployeeId: string;
    targetName: string;
    round: 1 | 2;
    unusedDays: number;
  }) => Promise<LeavePromotionOutcome>;
}

export function LeaveConsole({ ledger, requests, selfUserId, decide, createRequest, pushPromotion }: LeaveConsoleProps) {
  const S = leaveStrings();
  const D = densityStrings();
  const SUB = submitStrings();
  const windowManager = useOptionalWindowManager();
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [form, setForm] = useState<RequestForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);

  // 사유 + 기간 validity is derived, not a manual "확인" step — the debug-looking
  // "입력값 확인" button is gone (verdict R9). "incomplete" hides the preview,
  // "invalid" surfaces the range error, "valid" activates the 제출 link + day
  // count. §4-19 fail-closed: a typed enum 사유 and a start date are required.
  const requestValidation = useMemo(():
    | { state: "incomplete" }
    | { state: "invalid" }
    | { state: "valid"; days: number } => {
    const { reason, startDate } = form;
    if (reason === "" || startDate === "" || (!isHalfDay(reason) && form.endDate === "")) {
      return { state: "incomplete" };
    }
    const endDate = isHalfDay(reason) ? startDate : form.endDate;
    if (endDate < startDate) return { state: "invalid" };
    return { state: "valid", days: requestDays(reason, startDate, endDate) };
  }, [form]);

  const [decidingId, setDecidingId] = useState<string>();
  const [decideError, setDecideError] = useState<string>();
  // 반려(return)/거부(reject) both require a comment (근로기준법 결재 감사) — one
  // draft, tagged with which negative decision it will submit.
  const [commentDraftId, setCommentDraftId] = useState<string>();
  const [commentDecision, setCommentDecision] = useState<"return" | "reject">("reject");
  const [commentText, setCommentText] = useState("");
  const [commentError, setCommentError] = useState<string>();

  // Session-local §61 push tracking: no GET lists past pushes yet, so this
  // resets on reload rather than fabricating durable state (model.ts header).
  const [pushedRounds, setPushedRounds] = useState<Map<string, 1 | 2>>(new Map());
  const [pushingId, setPushingId] = useState<string>();
  const [pushError, setPushError] = useState<string>();
  const [pushResults, setPushResults] = useState<Map<string, LeaveStatutoryPushView>>(new Map());

  function openLedgerCard(row: LeaveLedgerRow): void {
    windowManager?.open(objectCardWindowEntry(ledgerDescriptor(row)));
  }

  const ledgerById = useMemo(() => new Map(ledger.map((row) => [row.id, row])), [ledger]);

  // ── Mutations ────────────────────────────────────────────────────────────

  async function runDecide(request: LeaveRequestView, decision: "approve" | "return" | "reject", comment?: string) {
    setDecidingId(request.id);
    setDecideError(undefined);
    const outcome = await decide(request.id, decision, comment);
    setDecidingId(undefined);
    if (!outcome.ok) {
      setDecideError(errorMessage(outcome.error, S.queue.decideFailed));
      return;
    }
    setCommentDraftId(undefined);
    setCommentText("");
  }

  function openComment(requestId: string, decision: "return" | "reject"): void {
    setCommentDraftId(requestId);
    setCommentDecision(decision);
    setCommentText("");
    setCommentError(undefined);
    setDecideError(undefined);
  }

  async function confirmComment(request: LeaveRequestView): Promise<void> {
    const trimmed = commentText.trim();
    if (trimmed === "") {
      setCommentError(S.queue.commentRequired);
      return;
    }
    setCommentError(undefined);
    await runDecide(request, commentDecision, trimmed);
  }

  // Editing the form clears a prior submit's success/error so stale feedback
  // never lingers over a fresh draft.
  function patchForm(patch: Partial<RequestForm>): void {
    if (submitting) return;
    setForm((prev) => ({ ...prev, ...patch }));
    if (submitted) setSubmitted(false);
    if (submitError !== undefined) setSubmitError(undefined);
  }

  async function submitRequest(): Promise<void> {
    // Guard: only a derived-valid form submits (§4-19 fail-closed). The subject
    // employee + branch are resolved server-side from the caller — never sent.
    if (requestValidation.state !== "valid" || submitting) return;
    const reason = form.reason;
    if (reason === "") return;
    const payload: LeaveCreateInput = {
      leave_type: isHalfDay(reason) ? "half_day" : "annual",
      start_date: form.startDate,
      end_date: isHalfDay(reason) ? form.startDate : form.endDate,
      // The typed 사유 label — the free-text reason the backend stores/validates.
      reason: S.reasons[reason],
    };
    setSubmitting(true);
    setSubmitError(undefined);
    setSubmitted(false);
    try {
      const outcome = await createRequest(payload);
      if (!outcome.ok) {
        setSubmitError(errorMessage(outcome.error, SUB.submitFailed));
        return;
      }
      setForm(EMPTY_FORM);
      setSubmitted(true);
    } catch (error) {
      setSubmitError(errorMessage(error, SUB.submitFailed));
    } finally {
      setSubmitting(false);
    }
  }

  function promotionCandidate(row: LeaveLedgerRow): LeaveRequestView | undefined {
    const candidates = requests.filter((request) => request.subject_employee_id === row.id);
    if (candidates.length === 0) return undefined;
    // Most recent filing — the only real (employee, account) pairing on hand;
    // the backend re-verifies it before any notice is delivered (model.ts).
    return candidates.reduce((latest, current) =>
      current.created_at > latest.created_at ? current : latest,
    );
  }

  async function sendPromotion(row: LeaveLedgerRow, round: 1 | 2, candidate: LeaveRequestView): Promise<void> {
    setPushingId(row.id);
    setPushError(undefined);
    const outcome = await pushPromotion({
      // The push is branch-scoped server-side (employee_directory_manage in
      // the target branch) — the branch lives on the linked request, never
      // guessed (model.ts: no employee→branch lookup REST exists standalone).
      branchId: candidate.branch_id,
      targetUserId: candidate.requester_user_id,
      targetEmployeeId: row.id,
      targetName: row.name,
      round,
      unusedDays: row.remaining,
    });
    setPushingId(undefined);
    if (!outcome.ok) {
      setPushError(errorMessage(outcome.error, S.promotion.pushFailed));
      return;
    }
    setPushedRounds((prev) => new Map(prev).set(row.id, round));
    if (outcome.push) {
      setPushResults((prev) => new Map(prev).set(row.id, outcome.push as LeaveStatutoryPushView));
    }
  }

  // ── Derived stats (drill = filter, §4-11) ──────────────────────────────────

  const activeRows = ledger.filter((row) => row.active);
  const accruedSum = activeRows.reduce((sum, row) => sum + row.accrued, 0);
  const usedSum = activeRows.reduce((sum, row) => sum + row.used, 0);
  const remainingSum = activeRows.reduce((sum, row) => sum + row.remaining, 0);
  const burnRate = accruedSum > 0 ? Math.round((usedSum / accruedSum) * 100) : 0;
  const promotionTargets = ledger.filter((row) => row.tone === "promote");

  const stats: { key: string; label: string; value: string; filter: LedgerFilter }[] = [
    { key: "headcount", label: S.stats.headcount, value: S.stats.people(activeRows.length), filter: "all" },
    { key: "remaining", label: S.stats.remaining, value: dayLabel(remainingSum), filter: "unspent" },
    { key: "burn", label: S.stats.burnRate, value: S.stats.percent(burnRate), filter: "unspent" },
    { key: "promotion", label: S.stats.promotionTargets, value: S.stats.people(promotionTargets.length), filter: "promotion" },
  ];

  const visibleLedger = ledger
    .filter((row) => {
      if (filter === "unspent") return row.active && row.remaining > 0;
      if (filter === "promotion") return row.tone === "promote";
      return true;
    })
    .slice(0, 80);

  const myRequests = selfUserId
    ? requests
        .filter((request) => request.requester_user_id === selfUserId)
        .slice()
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    : [];
  const pendingRequests = requests.filter((request) => request.status === "pending");

  // ── Row renderers ──────────────────────────────────────────────────────────

  function requestPeriod(request: LeaveRequestView): string {
    return request.start_date === request.end_date
      ? request.start_date
      : `${request.start_date} ~ ${request.end_date}`;
  }

  function requestRow(request: LeaveRequestView, cta: ReactNode): ReactNode {
    const employeeName = ledgerById.get(request.subject_employee_id)?.name ?? S.self.unknownEmployee;
    const showCommentDraft = commentDraftId === request.id;
    return (
      <li key={request.id} style={rowStyle}>
        <span style={cellNameStyle}>{employeeName}</span>
        <span style={cellMetaStyle}>{requestPeriod(request)}</span>
        <StatusChip tone="neutral">{S.leaveType[request.leave_type]}</StatusChip>
        <span style={cellMetaStyle}>{request.reason}</span>
        <StatusChip tone="info">{dayLabel(request.days)}</StatusChip>
        <StatusChip tone={requestTone[request.status]}>{S.requestState[request.status]}</StatusChip>
        {request.decision_comment !== undefined && request.decision_comment !== "" ? (
          <span style={cellMetaStyle}>{request.decision_comment}</span>
        ) : null}
        {cta}
        {showCommentDraft ? (
          <div style={{ ...formStyle, width: "100%" }}>
            <label style={{ ...labelStyle, flex: "1 1 240px" }}>
              {S.queue.commentLabel}
              <textarea
                required
                value={commentText}
                placeholder={S.queue.commentPlaceholder}
                onChange={(event) => { setCommentText(event.currentTarget.value); }}
                style={textareaStyle}
              />
            </label>
            {commentError !== undefined ? (
              <StatusChip role="alert" tone="danger">{commentError}</StatusChip>
            ) : null}
            <button
              type="button"
              disabled={decidingId === request.id}
              onClick={() => { void confirmComment(request); }}
              style={decidingId === request.id ? buttonDisabledStyle : primaryButtonStyle}
            >
              {commentDecision === "return" ? S.requestState.returned : S.queue.reject}
            </button>
            <button
              type="button"
              onClick={() => { setCommentDraftId(undefined); }}
              style={buttonStyle}
            >
              {S.queue.cancel}
            </button>
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <div className="console" data-console-module="leave" style={rootStyle}>
      {/* 연차 현황 — 1-row stat bar, every stat drills into the ledger filter */}
      <section aria-labelledby="leave-stats-title" style={cardStyle}>
        <h2 id="leave-stats-title" style={sectionTitleStyle}>{S.overviewTitle}</h2>
        <div role="group" aria-label={S.stats.aria} style={chipRowStyle}>
          {stats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              aria-pressed={filter === stat.filter}
              aria-label={S.stats.drill(stat.label)}
              onClick={() => { setFilter(filter === stat.filter ? "all" : stat.filter); }}
              style={statButtonStyle(filter === stat.filter && stat.filter !== "all")}
            >
              <span style={statLabelStyle}>{stat.label}</span>
              <span>{stat.value}</span>
            </button>
          ))}
        </div>
      </section>

      {/* 본인 persona — 내 신청 (server-filtered by requester_user_id, real) */}
      {selfUserId !== undefined ? (
        <PolicyGated action={LEAVE_ACTIONS.selfView} resource={{ kind: "leave_self", id: selfUserId }}>
          <section aria-labelledby="leave-self-title" style={cardStyle}>
            <div style={sectionHeadStyle}>
              <h2 id="leave-self-title" style={sectionTitleStyle}>{S.self.title}</h2>
            </div>
            <PolicyGated action={LEAVE_ACTIONS.requestCreate} resource={{ kind: "leave_request" }}>
              <form
                aria-label={S.self.formAria}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRequest();
                }}
                style={formStyle}
              >
                <label style={labelStyle}>
                  {S.self.reasonLabel}
                  <select
                    required
                    disabled={submitting}
                    value={form.reason}
                    onChange={(event) => {
                      const reason = event.currentTarget.value as LeaveReason | "";
                      patchForm({ reason });
                    }}
                    style={inputStyle}
                  >
                    <option value="" disabled>{S.self.reasonPlaceholder}</option>
                    {LEAVE_REASONS.map((reason) => (
                      <option key={reason} value={reason}>{S.reasons[reason]}</option>
                    ))}
                  </select>
                </label>
                <label style={labelStyle}>
                  {S.self.startLabel}
                  <KoDateField
                    ariaLabel={S.self.startLabel}
                    required
                    disabled={submitting}
                    value={form.startDate}
                    onChange={(startDate) => {
                      patchForm({ startDate });
                    }}
                  />
                </label>
                <label style={labelStyle}>
                  {S.self.endLabel}
                  <KoDateField
                    ariaLabel={S.self.endLabel}
                    required={!isHalfDay(form.reason)}
                    disabled={submitting || isHalfDay(form.reason)}
                    value={isHalfDay(form.reason) ? form.startDate : form.endDate}
                    onChange={(endDate) => {
                      patchForm({ endDate });
                    }}
                  />
                </label>
                <button
                  type="submit"
                  disabled={requestValidation.state !== "valid" || submitting}
                  style={
                    requestValidation.state === "valid" && !submitting
                      ? primaryButtonStyle
                      : buttonDisabledStyle
                  }
                >
                  {submitting ? SUB.submitting : SUB.submit}
                </button>
                {requestValidation.state === "invalid" ? (
                  <StatusChip role="alert" tone="danger">{S.self.invalidRange}</StatusChip>
                ) : null}
                {requestValidation.state === "valid" ? (
                  <StatusChip tone="ok">{dayLabel(requestValidation.days)}</StatusChip>
                ) : null}
                {submitError !== undefined ? (
                  <StatusChip role="alert" tone="danger">{submitError}</StatusChip>
                ) : null}
                {submitted ? (
                  <StatusChip role="status" tone="ok">{SUB.submitted}</StatusChip>
                ) : null}
              </form>
            </PolicyGated>
            {myRequests.length === 0 ? (
              <StatusChip tone="neutral">{S.self.empty}</StatusChip>
            ) : (
              <ul aria-label={S.self.myRequests} style={listStyle}>
                {myRequests.map((request) => requestRow(request, null))}
              </ul>
            )}
          </section>
        </PolicyGated>
      ) : null}

      <div className="leave-split">
        {/* 관리자/HR persona — 인원별 연차 원장 + usage bars */}
        <PolicyGated action={LEAVE_ACTIONS.ledgerView} resource={{ kind: "leave_ledger" }}>
          <section aria-labelledby="leave-ledger-title" style={cardStyle}>
            <div style={sectionHeadStyle}>
              <h2 id="leave-ledger-title" style={sectionTitleStyle}>{S.ledger.title}</h2>
              <StatusChip tone="neutral">{S.count(visibleLedger.length)}</StatusChip>
            </div>
            <div style={tableWrapStyle}>
              <table aria-label={S.ledger.listAria} style={tableStyle}>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>{S.ledger.columns.employee}</th>
                    <th scope="col" style={thStyle}>{S.ledger.columns.accrued}</th>
                    <th scope="col" style={thStyle}>{S.ledger.columns.used}</th>
                    <th scope="col" style={thStyle}>{S.ledger.columns.remaining}</th>
                    <th scope="col" style={thStyle}>{D.burnRateColumn}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLedger.map((row) => {
                    const burnRate = rowBurnRate(row);
                    // 부서(orgUnit)+직책(position) collapse into the name cell's
                    // subtitle — the balances roster carries no hire-date, so the
                    // tenure/상태 columns are dropped rather than shown as blanks
                    // (§4-25-⑥ ref density): 이름·부여·사용·잔여·소진율 only.
                    const subtitle = [row.orgUnit, row.position].filter((v) => v !== undefined).join(" · ");
                    return (
                      <tr key={row.id}>
                        <td style={tdStyle}>
                          <button
                            type="button"
                            {...objDrag(row.code, S.objects.ledgerTitle(row.name))}
                            aria-label={S.openObject(row.code)}
                            title={ko.console.window.dragRefOf(S.objects.ledgerTitle(row.name))}
                            onClick={() => { openLedgerCard(row); }}
                            style={codeButtonStyle}
                          >
                            {row.code}
                          </button>
                          <p style={cellNameStyle}>{row.name}</p>
                          {subtitle !== "" ? <p style={cellMetaStyle}>{subtitle}</p> : null}
                        </td>
                        <td style={tdStyle}>{dayLabel(row.accrued)}</td>
                        <td style={tdStyle}>{dayLabel(row.used)}</td>
                        <td style={tdStyle}>{dayLabel(row.remaining)}</td>
                        <td style={tdStyle}>
                          <span style={meterCellStyle}>
                            <span style={meterTrackStyle} aria-hidden="true">
                              <span style={meterFillStyle(burnRate, row.tone)} />
                            </span>
                            <span style={meterValueStyle}>{S.stats.percent(burnRate)}</span>
                            {row.tone === "promote" ? (
                              <StatusChip tone="warn">{S.status.promote}</StatusChip>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </PolicyGated>

        {/* 팀장 persona — pending queue + decide (SoD: 본인 신청은 결재 불가) */}
        <PolicyGated action={LEAVE_ACTIONS.queueView} resource={{ kind: "leave_queue" }}>
          <section aria-labelledby="leave-queue-title" style={cardStyle}>
            <div style={sectionHeadStyle}>
              <h2 id="leave-queue-title" style={sectionTitleStyle}>{S.queue.title}</h2>
              <StatusChip tone="warn">{S.count(pendingRequests.length)}</StatusChip>
            </div>
            {decideError !== undefined ? (
              <StatusChip role="alert" tone="danger">{decideError}</StatusChip>
            ) : null}
            {pendingRequests.length === 0 ? (
              <StatusChip tone="neutral">{S.queue.empty}</StatusChip>
            ) : (
              <ul aria-label={S.queue.aria} style={listStyle}>
                {pendingRequests.map((request) => {
                  const employeeName = ledgerById.get(request.subject_employee_id)?.name ?? S.self.unknownEmployee;
                  // SoD — approver ≠ requester is surfaced, not silently hidden:
                  // the decider's own request shows a "내 신청" marker in place of
                  // the decide controls (backend also 403s a self-decision). S3
                  // fix: an unresolved identity (selfUserId undefined — session
                  // still loading) fails CLOSED as self, so decide controls never
                  // flash for an unverified caller.
                  const isSelf = request.requester_user_id === selfUserId;
                  const decideCta =
                    selfUserId === undefined ? null : isSelf ? (
                      <StatusChip tone="neutral">{S.self.myRequests}</StatusChip>
                    ) : (
                      <PolicyGated
                        action={LEAVE_ACTIONS.requestDecide}
                        resource={{ kind: "leave_request", id: request.id }}
                      >
                        <span style={chipRowStyle}>
                          <button
                            type="button"
                            disabled={decidingId === request.id}
                            aria-label={S.queue.decideAria(S.queue.approve, employeeName)}
                            onClick={() => { void runDecide(request, "approve"); }}
                            style={decidingId === request.id ? buttonDisabledStyle : primaryButtonStyle}
                          >
                            {S.queue.approve}
                          </button>
                          <button
                            type="button"
                            disabled={decidingId === request.id}
                            aria-label={S.queue.decideAria(S.requestState.returned, employeeName)}
                            onClick={() => { openComment(request.id, "return"); }}
                            style={decidingId === request.id ? buttonDisabledStyle : buttonStyle}
                          >
                            {S.requestState.returned}
                          </button>
                          <button
                            type="button"
                            disabled={decidingId === request.id}
                            aria-label={S.queue.decideAria(S.queue.reject, employeeName)}
                            onClick={() => { openComment(request.id, "reject"); }}
                            style={decidingId === request.id ? buttonDisabledStyle : buttonStyle}
                          >
                            {S.queue.reject}
                          </button>
                        </span>
                      </PolicyGated>
                    );
                  return requestRow(request, decideCta);
                })}
              </ul>
            )}
          </section>
        </PolicyGated>
      </div>

      {/* HR 전담 persona — 사용촉진 대상 + 발송 (근로기준법 §61), one panel:
          target list, next-round send, and post-push state all live here
          (merged from the old table-embedded button + separate history
          panel — same internals: promotionCandidate/sendPromotion/pushed*
          maps, just consolidated to match the reference density). */}
      <PolicyGated action={LEAVE_ACTIONS.promotionView} resource={{ kind: "leave_promotion" }}>
        <section aria-labelledby="leave-promotion-queue-title" style={cardStyle}>
          <div style={sectionHeadStyle}>
            <h2 id="leave-promotion-queue-title" style={sectionTitleStyle}>{D.queueTitle}</h2>
            <StatusChip tone="purple">{S.promotion.legalBasis}</StatusChip>
            <StatusChip tone="neutral">{S.count(promotionTargets.length)}</StatusChip>
          </div>
          {pushError !== undefined ? (
            <StatusChip role="alert" tone="danger">{pushError}</StatusChip>
          ) : null}
          {promotionTargets.length === 0 ? (
            <StatusChip tone="neutral">{D.emptyQueue}</StatusChip>
          ) : (
            <ul aria-label={S.promotion.listAria} style={listStyle}>
              {promotionTargets.map((row) => {
                const candidate = promotionCandidate(row);
                const alreadyRound = pushedRounds.get(row.id);
                const pushed = pushResults.get(row.id);
                const nextRound: 1 | 2 | undefined =
                  alreadyRound === undefined ? 1 : alreadyRound === 1 ? 2 : undefined;
                return (
                  <li key={row.id} style={rowStyle}>
                    <span style={cellNameStyle}>{row.name}</span>
                    <StatusChip tone="warn">{D.unusedLabel(dayLabel(row.remaining))}</StatusChip>
                    {pushed ? (
                      <>
                        <StatusChip tone="info">{S.promotion.roundChip(pushed.round)}</StatusChip>
                        <StatusChip tone="ok">{S.promotion.pushed}</StatusChip>
                        <StatusChip tone={pushed.ap_submission === "submitted" ? "ok" : "neutral"}>
                          {S.promotion.apStatus[pushed.ap_submission]}
                        </StatusChip>
                      </>
                    ) : null}
                    {nextRound !== undefined ? (
                      <PolicyGated
                        action={LEAVE_ACTIONS.promotionManage}
                        resource={{ kind: "leave_ledger", id: row.id }}
                      >
                        {candidate ? (
                          <button
                            type="button"
                            disabled={pushingId === row.id}
                            aria-label={S.promotion.sendAria(row.name, nextRound)}
                            onClick={() => { void sendPromotion(row, nextRound, candidate); }}
                            style={pushingId === row.id ? buttonDisabledStyle : buttonStyle}
                          >
                            {S.promotion.send(nextRound)}
                          </button>
                        ) : (
                          <StatusChip tone="neutral">{S.promotion.noLinkedRequest}</StatusChip>
                        )}
                      </PolicyGated>
                    ) : (
                      <StatusChip tone="ok">{S.promotion.done}</StatusChip>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </PolicyGated>
    </div>
  );
}
