// Console screen composition for 지원 센터 (support). Reuses the REAL
// support-desk data + REST wiring the legacy SupportPage.tsx already proved
// (same /api/v1/support/tickets{,/{id},/{id}/transition,/{id}/comments,
// /{id}/assign} endpoints, same buildSupportStats/filterTickets/SLO model,
// §4-18) — this file only supplies console-pure JSX (tokens.css, no
// shadcn/Tailwind) instead of the legacy page's components/ui/* chrome, since
// check-console-purity bans components/{ui,shell} under console/**.
//
// Grammar: §4-11 one-row drillable stat strip (open/urgent·SLO/unassigned/
// resolved — the REAL categories the ticket data supports; the design
// reference's "기능요청/FAQ" tiles have no backing object type yet, so this
// screen does not fabricate them, §4-25-⑥), a filterable ticket table, and a
// 3rd-pane ticket detail card with an SLO timer chip + a document-flow rail
// (ticket → dispatch → messenger → mail → reporting), mirroring
// TicketObjectRail in features/support/SupportTicketDetail.tsx.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import type {
  CreateInternalTicketRequest,
  SupportTicketCategory,
  SupportTicketComment,
  SupportTicketDetail as SupportTicketDetailModel,
  SupportTicketPriority,
  SupportTicketStatus,
  SupportTicketSummary,
} from "../../../api/types";
import {
  allowedTransitions,
  categoryLabel,
  formatDateTime,
  originLabel,
  priorityLabel,
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  sloTimerChip,
  statusLabel,
  ticketCode,
  transitionActionLabel,
} from "../../../features/support/support-format";
// §4-18: reuse the REAL multi-field ticket search the legacy support desk
// proved (title/requester/assignee/category/origin/priority/status), not a
// re-implemented title-only match.
import { filterTickets } from "../../../pages/SupportPage";
import {
  defaultSloSettings,
  sloPosture,
} from "../../../features/support/slo-settings";
import { useActiveBranchId, useAuth } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { StatusChip } from "../../components";
import { objDrag } from "../../window";
import "../../tokens.css";
import {
  buildSupportStats,
  canAssignTickets,
  canCommentOnTickets,
  drillItems,
  priorityTone,
  sloTone,
  statusTone,
  type Drill,
} from "./model";

const S = ko.support;
// The generic-module-template config for this same object type
// (console/module/moduleConfigs.ts supportTicketModuleConfig) titles this
// screen "회신" — stale copy from before the ticket-based support desk
// replaced it. Fixed here via koManifest (this lane cannot edit ko.ts): the
// shared key is corrected to "지원 센터" rather than adding a duplicate.
const SCREEN_TITLE = ko.console.module.support.title;

// ── Styles (tokens only, 8px grid via --sp-*, §4-25-⑧) ──────────────────────

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-5)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  minHeight: 0,
  overflow: "auto",
};

const headRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-3)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-page-title, 20px)",
  fontWeight: "var(--fw-strong)",
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

function tabButtonStyle(pressed: boolean): CSSProperties {
  return {
    minHeight: 44,
    padding: "0 var(--sp-3)",
    borderRadius: "var(--radius-md)",
    border: `1px solid ${pressed ? "var(--signal)" : "var(--border)"}`,
    background: pressed ? "var(--accent-bg)" : "var(--surface)",
    color: "var(--ink)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--fw-strong)",
    cursor: "pointer",
  };
}

const splitStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)",
  alignItems: "start",
  minWidth: 0,
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius)",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse" };

const thStyle: CSSProperties = {
  padding: "var(--sp-3) var(--sp-4)",
  borderBottom: "1px solid var(--border-soft)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  textAlign: "left",
  whiteSpace: "nowrap",
};

function tdStyle(selected: boolean): CSSProperties {
  return {
    padding: "var(--sp-3) var(--sp-4)",
    borderBottom: "1px solid var(--border-soft)",
    background: selected ? "var(--accent-bg)" : "transparent",
  };
}

function rowButtonStyle(): CSSProperties {
  return {
    all: "unset",
    display: "block",
    width: "100%",
    cursor: "pointer",
    color: "var(--ink)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--fw-body)",
  };
}

const codeChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 28,
  padding: "0 var(--sp-2)",
  borderRadius: "var(--radius-chip)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  cursor: "grab",
};

const dlStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "var(--sp-3)",
  margin: 0,
  fontSize: "var(--text-sm)",
};

const dtStyle: CSSProperties = { color: "var(--steel)", fontWeight: "var(--fw-strong)" };
const ddStyle: CSSProperties = { margin: 0, color: "var(--ink)" };

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

const buttonDisabledStyle: CSSProperties = { ...buttonStyle, cursor: "not-allowed", opacity: 0.5 };

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: "1px solid var(--signal-deep)",
  background: "var(--signal)",
  color: "var(--accent-tx)",
};

const searchInputStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const selectStyle: CSSProperties = { ...searchInputStyle, cursor: "pointer" };

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const linkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 36,
  padding: "0 var(--sp-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
  textDecoration: "none",
};

const textareaStyle: CSSProperties = {
  minHeight: 72,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "var(--sp-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  resize: "vertical",
};

// ── Component ─────────────────────────────────────────────────────────────

type ReadState = "loading" | "idle" | "error";

export function SupportBody() {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();
  const currentUserId = session?.user_id;
  const canAssign = canAssignTickets(session?.roles);
  const canComment = canCommentOnTickets(session?.roles);
  // wire-pending: Phase C — GET /api/v1/ontology/instances?type=support_slo_setting
  // (see slo-settings.ts header); the ACTIVE default seeds the timer chips.
  const [sloRules] = useState(() => defaultSloSettings().active);

  const [tickets, setTickets] = useState<SupportTicketSummary[]>([]);
  const [listState, setListState] = useState<ReadState>("loading");
  const [nowMs, setNowMs] = useState(0);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [statusFilter, setStatusFilter] = useState<SupportTicketStatus | "">("");
  const [selectedId, setSelectedId] = useState<string>();

  const [detail, setDetail] = useState<SupportTicketDetailModel>();
  const [detailState, setDetailState] = useState<ReadState>("idle");
  const [commentBody, setCommentBody] = useState("");
  const [commentInternal, setCommentInternal] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const [transitionBusy, setTransitionBusy] = useState<SupportTicketStatus | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [createCategory, setCreateCategory] = useState<SupportTicketCategory>(SUPPORT_CATEGORIES[0]);
  const [createPriority, setCreatePriority] = useState<SupportTicketPriority>("MEDIUM");
  const [createBusy, setCreateBusy] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  const loadTickets = useCallback(async () => {
    setListState("loading");
    const response = await api
      .GET("/api/v1/support/tickets", {
        params: { query: { include_untriaged: true, limit: 50 } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setListState("error");
      return;
    }
    setTickets(response.data.items);
    setNowMs(Date.now());
    setListState("idle");
    // Pre-select the first ticket so the 3rd pane reads populated on load
    // (matches the reference — never leaves a blank "select a ticket"
    // detail pane when there's clearly a first row to show). Only on the
    // initial load: a functional update means a user's existing selection
    // (or their having cleared it) is never clobbered by a later refetch.
    setSelectedId((current) => current ?? response.data.items[0]?.id);
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadTickets);
  }, [loadTickets]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const loadDetail = useCallback(
    async (ticketId: string) => {
      setDetailState("loading");
      const response = await api
        .GET("/api/v1/support/tickets/{id}", { params: { path: { id: ticketId } } })
        .catch(() => undefined);
      if (!response?.data) {
        setDetailState("error");
        return;
      }
      setDetail(response.data);
      setDetailState("idle");
    },
    [api],
  );

  useEffect(() => {
    if (selectedId) void Promise.resolve().then(() => loadDetail(selectedId));
  }, [selectedId, loadDetail]);

  const stats = useMemo(() => buildSupportStats(tickets, nowMs, sloRules), [tickets, nowMs, sloRules]);
  const items = useMemo(() => drillItems(stats), [stats]);

  const visibleTickets = useMemo(() => {
    const searched = filterTickets(tickets, search.trim());
    const byStatus = statusFilter
      ? searched.filter((t) => t.status === statusFilter)
      : searched;
    if (!drill) return byStatus;
    return byStatus.filter((ticket) => {
      switch (drill) {
        case "open":
          return ticket.status !== "RESOLVED" && ticket.status !== "CLOSED";
        case "urgent":
          return (
            ticket.priority === "URGENT" ||
            sloPosture(ticket, sloRules, nowMs) === "overdue"
          );
        case "unassigned":
          return !ticket.assignee_user_id;
        case "resolved":
          return ticket.status === "RESOLVED" || ticket.status === "CLOSED";
      }
    });
  }, [tickets, search, statusFilter, drill, sloRules, nowMs]);

  async function createTicket(): Promise<void> {
    if (!branchId || createTitle.trim().length === 0 || createBody.trim().length === 0) return;
    setCreateBusy(true);
    setCreateFailed(false);
    const body: CreateInternalTicketRequest = {
      branch_id: branchId,
      category: createCategory,
      priority: createPriority,
      title: createTitle.trim(),
      body: createBody.trim(),
    };
    const response = await api
      .POST("/api/v1/support/tickets", { body })
      .catch(() => undefined);
    setCreateBusy(false);
    if (!response?.data) {
      setCreateFailed(true);
      return;
    }
    setShowCreate(false);
    setCreateTitle("");
    setCreateBody("");
    setCreateCategory(SUPPORT_CATEGORIES[0]);
    setCreatePriority("MEDIUM");
    await loadTickets();
    setSelectedId(response.data.id);
  }

  async function runTransition(to: SupportTicketStatus): Promise<void> {
    if (!selectedId) return;
    setTransitionBusy(to);
    setActionFailed(false);
    const response = await api
      .POST("/api/v1/support/tickets/{id}/transition", {
        params: { path: { id: selectedId } },
        body: { to_status: to },
      })
      .catch(() => undefined);
    setTransitionBusy(null);
    if (!response?.data) {
      setActionFailed(true);
      return;
    }
    await Promise.all([loadDetail(selectedId), loadTickets()]);
  }

  async function runAssignSelf(): Promise<void> {
    if (!selectedId || !currentUserId || !branchId) return;
    setAssignBusy(true);
    setActionFailed(false);
    const response = await api
      .POST("/api/v1/support/tickets/{id}/assign", {
        params: { path: { id: selectedId } },
        body: { assignee_user_id: currentUserId, branch_id: branchId },
      })
      .catch(() => undefined);
    setAssignBusy(false);
    if (!response?.data) {
      setActionFailed(true);
      return;
    }
    await Promise.all([loadDetail(selectedId), loadTickets()]);
  }

  async function submitComment(): Promise<void> {
    if (!selectedId || commentBody.trim().length === 0) return;
    setCommentBusy(true);
    const response = await api
      .POST("/api/v1/support/tickets/{id}/comments", {
        params: { path: { id: selectedId } },
        body: { body: commentBody.trim(), is_internal_note: commentInternal },
      })
      .catch(() => undefined);
    setCommentBusy(false);
    if (!response?.data) {
      setActionFailed(true);
      return;
    }
    setCommentBody("");
    setCommentInternal(false);
    await loadDetail(selectedId);
  }

  return (
    <div style={rootStyle}>
      <div style={headRowStyle}>
        <h1 style={titleStyle}>{SCREEN_TITLE}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", marginLeft: "auto" }}>
          <input
            type="search"
            value={search}
            aria-label={S.searchAria}
            placeholder={S.searchPlaceholder}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
            style={searchInputStyle}
          />
          <button
            type="button"
            aria-expanded={showCreate}
            onClick={() => {
              setShowCreate((current) => !current);
            }}
            style={primaryButtonStyle}
          >
            {S.createTitle}
          </button>
        </div>
        <div role="group" aria-label={ko.console.supportdesk.statsAria} style={chipRowStyle}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={drill === item.key}
              aria-label={ko.console.supportdesk.drill(item.label)}
              onClick={() => {
                setDrill((current) => (current === item.key ? null : item.key));
              }}
              style={statButtonStyle(drill === item.key)}
            >
              <span style={{ color: "var(--faint)", fontSize: "var(--text-xs)" }}>
                {item.label}
              </span>
              <span>{item.value}</span>
            </button>
          ))}
        </div>
      </div>

      {showCreate ? (
        <form
          aria-label={S.createTitle}
          onSubmit={(event) => {
            event.preventDefault();
            void createTicket();
          }}
          style={{ ...cardStyle, gap: "var(--sp-3)" }}
        >
          <h2 style={{ margin: 0, fontSize: "var(--text-card-title)" }}>{S.createTitle}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--sp-3)" }}>
            <label style={fieldLabelStyle}>
              {S.form.category}
              <select
                value={createCategory}
                onChange={(event) => {
                  setCreateCategory(event.currentTarget.value as SupportTicketCategory);
                }}
                style={selectStyle}
              >
                {SUPPORT_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {categoryLabel(category)}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabelStyle}>
              {S.form.priority}
              <select
                value={createPriority}
                onChange={(event) => {
                  setCreatePriority(event.currentTarget.value as SupportTicketPriority);
                }}
                style={selectStyle}
              >
                {SUPPORT_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priorityLabel(priority)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label style={fieldLabelStyle}>
            {S.form.ticketTitle}
            <input
              value={createTitle}
              placeholder={S.form.titlePlaceholder}
              onChange={(event) => {
                setCreateTitle(event.currentTarget.value);
              }}
              style={searchInputStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            {S.form.body}
            <textarea
              value={createBody}
              placeholder={S.form.bodyPlaceholder}
              onChange={(event) => {
                setCreateBody(event.currentTarget.value);
              }}
              style={textareaStyle}
            />
          </label>
          {createFailed ? (
            <StatusChip tone="danger" role="alert">
              {S.form.submitFailed}
            </StatusChip>
          ) : null}
          <div style={chipRowStyle}>
            <button
              type="submit"
              disabled={
                createBusy ||
                !branchId ||
                createTitle.trim().length === 0 ||
                createBody.trim().length === 0
              }
              style={
                createBusy ||
                !branchId ||
                createTitle.trim().length === 0 ||
                createBody.trim().length === 0
                  ? buttonDisabledStyle
                  : primaryButtonStyle
              }
            >
              {createBusy ? S.form.submitting : S.form.submit}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
              }}
              style={buttonStyle}
            >
              {ko.common.cancel}
            </button>
          </div>
        </form>
      ) : null}

      <div style={splitStyle}>
        <section aria-labelledby="support-ticket-list-title" style={cardStyle}>
          <div style={chipRowStyle}>
            <h2 id="support-ticket-list-title" style={{ margin: 0, fontSize: "var(--text-card-title)" }}>
              {S.listTitle}
            </h2>
            <StatusChip tone="neutral">{visibleTickets.length}</StatusChip>
          </div>

          <div role="group" aria-label={S.filters.status} style={chipRowStyle}>
            <button
              type="button"
              aria-pressed={statusFilter === ""}
              onClick={() => {
                setStatusFilter("");
              }}
              style={tabButtonStyle(statusFilter === "")}
            >
              {S.filters.all}
            </button>
            {SUPPORT_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                aria-pressed={statusFilter === status}
                onClick={() => {
                  setStatusFilter((current) => (current === status ? "" : status));
                }}
                style={tabButtonStyle(statusFilter === status)}
              >
                {statusLabel(status)}
              </button>
            ))}
          </div>

          {listState === "error" ? (
            <StatusChip tone="danger" role="alert">
              {ko.console.module.list.error}
            </StatusChip>
          ) : null}

          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{ko.console.module.support.col.title}</th>
                  <th style={thStyle}>{ko.console.module.support.col.status}</th>
                </tr>
              </thead>
              <tbody>
                {listState === "loading" ? (
                  <tr>
                    <td style={tdStyle(false)} colSpan={2}>
                      <span role="status">{ko.common.loading}</span>
                    </td>
                  </tr>
                ) : visibleTickets.length === 0 ? (
                  <tr>
                    <td style={tdStyle(false)} colSpan={2}>
                      {S.empty}
                    </td>
                  </tr>
                ) : (
                  visibleTickets.map((ticket) => (
                    <tr key={ticket.id}>
                      <td style={tdStyle(ticket.id === selectedId)}>
                        <button
                          type="button"
                          aria-pressed={ticket.id === selectedId}
                          onClick={() => {
                            setSelectedId(ticket.id);
                          }}
                          style={rowButtonStyle()}
                        >
                          {ticket.title}
                        </button>
                      </td>
                      <td style={tdStyle(ticket.id === selectedId)}>
                        <StatusChip tone={statusTone(ticket.status)}>
                          {statusLabel(ticket.status)}
                        </StatusChip>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {selectedId ? (
          <TicketDetailPane
            detailState={detailState}
            detail={detail}
            nowMs={nowMs}
            sloRules={sloRules}
            canAssign={canAssign}
            canComment={canComment}
            currentUserId={currentUserId}
            transitionBusy={transitionBusy}
            assignBusy={assignBusy}
            commentBody={commentBody}
            commentInternal={commentInternal}
            commentBusy={commentBusy}
            actionFailed={actionFailed}
            onTransition={(to) => {
              void runTransition(to);
            }}
            onAssignSelf={() => {
              void runAssignSelf();
            }}
            onCommentBodyChange={setCommentBody}
            onCommentInternalChange={setCommentInternal}
            onSubmitComment={() => {
              void submitComment();
            }}
            onRetry={() => {
              void loadDetail(selectedId);
            }}
          />
        ) : (
          <StatusChip tone="neutral">{S.selectPrompt}</StatusChip>
        )}
      </div>
    </div>
  );
}

interface TicketDetailPaneProps {
  detailState: ReadState;
  detail: SupportTicketDetailModel | undefined;
  nowMs: number;
  sloRules: Parameters<typeof sloTimerChip>[1];
  canAssign: boolean;
  canComment: boolean;
  currentUserId: string | undefined;
  transitionBusy: SupportTicketStatus | null;
  assignBusy: boolean;
  commentBody: string;
  commentInternal: boolean;
  commentBusy: boolean;
  actionFailed: boolean;
  onTransition: (to: SupportTicketStatus) => void;
  onAssignSelf: () => void;
  onCommentBodyChange: (value: string) => void;
  onCommentInternalChange: (value: boolean) => void;
  onSubmitComment: () => void;
  onRetry: () => void;
}

const DOCUMENT_FLOW: { label: string; href: (id: string) => string }[] = [
  { label: S.objectRail.workOrder, href: (id) => `/dispatch?source=support&ticket=${id}` },
  { label: S.objectRail.messenger, href: (id) => `/messenger?source=support&ticket=${id}` },
  { label: S.objectRail.mail, href: (id) => `/mail?source=support&ticket=${id}` },
  { label: S.objectRail.reporting, href: (id) => `/reporting?source=support&ticket=${id}` },
];

function TicketDetailPane({
  detailState,
  detail,
  nowMs,
  sloRules,
  canAssign,
  canComment,
  currentUserId,
  transitionBusy,
  assignBusy,
  commentBody,
  commentInternal,
  commentBusy,
  actionFailed,
  onTransition,
  onAssignSelf,
  onCommentBodyChange,
  onCommentInternalChange,
  onSubmitComment,
  onRetry,
}: TicketDetailPaneProps) {
  if (detailState === "error") {
    return (
      <section style={cardStyle}>
        <StatusChip tone="danger" role="alert">
          {ko.console.workflows.errors.loadFailed}
        </StatusChip>
        <button type="button" style={buttonStyle} onClick={onRetry}>
          {ko.console.module.list.retry}
        </button>
      </section>
    );
  }
  if (!detail) {
    return (
      <section style={cardStyle}>
        <span role="status">{ko.common.loading}</span>
      </section>
    );
  }

  const { ticket, comments } = detail;
  const code = ticketCode(ticket.id);
  const chip = sloTimerChip(ticket, sloRules, nowMs);
  const posture = sloPosture(ticket, sloRules, nowMs);
  const transitions = allowedTransitions(ticket.status);
  const alreadyMine = currentUserId !== undefined && ticket.assignee_user_id === currentUserId;

  return (
    <section aria-labelledby="support-detail-title" style={cardStyle}>
      <div style={chipRowStyle}>
        <span
          {...objDrag(code, ticket.title)}
          title={ko.console.window.dragRefOf(ticket.title)}
          style={codeChipStyle}
        >
          {code}
        </span>
        <StatusChip tone={priorityTone(ticket.priority)}>{priorityLabel(ticket.priority)}</StatusChip>
        <StatusChip tone={statusTone(ticket.status)}>{statusLabel(ticket.status)}</StatusChip>
        <StatusChip tone="neutral">{originLabel(ticket.origin)}</StatusChip>
        <StatusChip tone="neutral">{categoryLabel(ticket.category)}</StatusChip>
        {chip ? <StatusChip tone={sloTone(posture)}>{chip.label}</StatusChip> : null}
      </div>

      <h2 id="support-detail-title" style={{ margin: 0, fontSize: "var(--text-card-title)" }}>
        {ticket.title}
      </h2>

      <dl style={dlStyle}>
        <div>
          <dt style={dtStyle}>{S.requester}</dt>
          <dd style={ddStyle}>{ticket.requester_name ?? ko.common.unknown}</dd>
        </div>
        <div>
          <dt style={dtStyle}>{S.assignee}</dt>
          <dd style={ddStyle}>
            {ticket.assignee_user_id ? (ticket.assignee_name ?? ko.common.unknown) : S.unassigned}
          </dd>
        </div>
        <div>
          <dt style={dtStyle}>{S.dueAt}</dt>
          <dd style={ddStyle}>{formatDateTime(ticket.due_at)}</dd>
        </div>
        <div>
          <dt style={dtStyle}>{S.createdAt}</dt>
          <dd style={ddStyle}>{formatDateTime(ticket.created_at)}</dd>
        </div>
      </dl>

      <nav aria-label={S.objectRail.title} style={{ ...chipRowStyle, flexDirection: "column", alignItems: "flex-start" }}>
        <span style={{ color: "var(--steel)", fontSize: "var(--text-xs)", fontWeight: "var(--fw-strong)" }}>
          {S.objectRail.title}
        </span>
        <div style={chipRowStyle}>
          {DOCUMENT_FLOW.map((link) => (
            <a key={link.label} style={linkStyle} href={link.href(ticket.id)}>
              {link.label}
            </a>
          ))}
        </div>
      </nav>

      {canAssign ? (
        <div style={{ ...chipRowStyle, borderTop: "1px solid var(--border-soft)", paddingTop: "var(--sp-4)" }}>
          <span style={{ color: "var(--steel)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-strong)" }}>
            {S.transition.title}
          </span>
          {transitions.length === 0 ? (
            <span style={{ color: "var(--steel)", fontSize: "var(--text-sm)" }}>{S.transition.none}</span>
          ) : (
            transitions.map((to) => (
              <button
                key={to}
                type="button"
                disabled={transitionBusy !== null}
                onClick={() => {
                  onTransition(to);
                }}
                style={transitionBusy !== null ? buttonDisabledStyle : buttonStyle}
              >
                {transitionBusy === to ? S.transition.changing : transitionActionLabel(ticket.status, to)}
              </button>
            ))
          )}
          {!alreadyMine ? (
            <button
              type="button"
              disabled={assignBusy}
              onClick={onAssignSelf}
              style={assignBusy ? buttonDisabledStyle : buttonStyle}
            >
              {assignBusy ? S.assigning : S.assignSelf}
            </button>
          ) : null}
        </div>
      ) : null}

      {actionFailed ? (
        <StatusChip tone="danger" role="alert">
          {S.transition.failed}
        </StatusChip>
      ) : null}

      <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: "var(--sp-4)", display: "grid", gap: "var(--sp-3)" }}>
        <span style={{ color: "var(--steel)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-strong)" }}>
          {S.comments.title}
        </span>
        <CommentThread comments={comments} />
        {canComment ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitComment();
            }}
            style={{ display: "grid", gap: "var(--sp-2)" }}
          >
            <label className="sr-only" htmlFor="support-comment-body" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
              {S.comments.title}
            </label>
            <textarea
              id="support-comment-body"
              value={commentBody}
              placeholder={S.comments.placeholder}
              onChange={(event) => {
                onCommentBodyChange(event.currentTarget.value);
              }}
              style={textareaStyle}
            />
            <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", color: "var(--steel)", fontSize: "var(--text-sm)" }}>
              <input
                type="checkbox"
                checked={commentInternal}
                onChange={(event) => {
                  onCommentInternalChange(event.currentTarget.checked);
                }}
              />
              {S.comments.markInternal}
            </label>
            <button
              type="submit"
              disabled={commentBusy || commentBody.trim().length === 0}
              style={
                commentBusy || commentBody.trim().length === 0 ? buttonDisabledStyle : buttonStyle
              }
            >
              {commentBusy ? S.comments.adding : S.comments.add}
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

function CommentThread({ comments }: { comments: SupportTicketComment[] }) {
  if (comments.length === 0) {
    return <StatusChip tone="neutral">{S.comments.empty}</StatusChip>;
  }
  return (
    <ul style={{ ...dlStyle, gridTemplateColumns: "1fr", listStyle: "none", padding: 0 }}>
      {comments.map((comment) => (
        <li
          key={comment.id}
          style={{
            display: "grid",
            gap: "var(--sp-1)",
            padding: "var(--sp-3)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border-soft)",
            background: comment.is_internal_note ? "var(--warn-bg)" : "var(--surface)",
          }}
        >
          <div style={chipRowStyle}>
            {comment.is_internal_note ? (
              <StatusChip tone="warn">{S.comments.internalNote}</StatusChip>
            ) : null}
            <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--fw-strong)" }}>
              {comment.author_user_id ? (comment.author_name ?? ko.common.unknown) : S.comments.systemAuthor}
            </span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--steel)" }}>
              {formatDateTime(comment.created_at)}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "var(--text-sm)", whiteSpace: "pre-wrap" }}>{comment.body}</p>
        </li>
      ))}
    </ul>
  );
}
