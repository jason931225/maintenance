// Ticket detail as a §4.7-3 right-pin body. Self-contained on purpose: a
// WindowEntry's render() persists across screen navigation, so this panel owns
// its own detail fetch + mutations (transition / comment / assign / escalate)
// against the real /support/tickets REST instead of borrowing page state.

import { useCallback, useEffect, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  SupportTicketDetail as SupportTicketDetailModel,
  SupportTicketStatus,
} from "../../api/types";
import { Card } from "../../components/ui/card";
import { PageError } from "../../components/states/PageError";
import { ko } from "../../i18n/ko";
import type { SloRules } from "./slo-settings";
import { supportDeskStrings } from "./support-desk-strings";
import { sloTimerChip } from "./support-format";
import { supportSloStrings } from "./supportslo-strings";
import { SupportTicketDetail } from "./SupportTicketDetail";

export interface SupportTicketPinProps {
  api: ConsoleApiClient;
  ticketId: string;
  /** SUP- object code (ticketCode) — mono chip + drag source in the header. */
  code: string;
  currentUserId?: string;
  branchId?: string;
  canAssign: boolean;
  canComment: boolean;
  /** ACTIVE SLO setting — the timer chip + escalation target derive from it. */
  sloRules: SloRules;
  /** Called after a mutation the ticket LIST can observe (status/assignee). */
  onMutated?: () => void;
}

type ReadState = "idle" | "loading" | "error";

export function SupportTicketPin({
  api,
  ticketId,
  code,
  currentUserId,
  branchId,
  canAssign,
  canComment,
  sloRules,
  onMutated,
}: SupportTicketPinProps) {
  const [detail, setDetail] = useState<SupportTicketDetailModel>();
  const [state, setState] = useState<ReadState>("loading");
  // Wall-clock for the SLO timer chip — stamped per load, re-stamped each
  // minute so a long-pinned panel stays honest.
  const [nowMs, setNowMs] = useState(0);

  const load = useCallback(async () => {
    setState("loading");
    const response = await api
      .GET("/api/v1/support/tickets/{id}", { params: { path: { id: ticketId } } })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setDetail(response.data);
    setNowMs(Date.now());
    setState("idle");
  }, [api, ticketId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  async function transition(to: SupportTicketStatus): Promise<void> {
    const response = await api.POST("/api/v1/support/tickets/{id}/transition", {
      params: { path: { id: ticketId } },
      body: { to_status: to },
    });
    if (!response.data) {
      throw new Error("transition failed");
    }
    await load();
    onMutated?.();
  }

  async function addComment(
    body: string,
    isInternalNote: boolean,
  ): Promise<void> {
    const response = await api.POST("/api/v1/support/tickets/{id}/comments", {
      params: { path: { id: ticketId } },
      body: { body, is_internal_note: isInternalNote },
    });
    if (!response.data) {
      throw new Error("addComment failed");
    }
    await load();
  }

  async function assignSelf(): Promise<void> {
    if (!currentUserId || !branchId) return;
    const response = await api.POST("/api/v1/support/tickets/{id}/assign", {
      params: { path: { id: ticketId } },
      body: { assignee_user_id: currentUserId, branch_id: branchId },
    });
    if (!response.data) {
      throw new Error("assign failed");
    }
    await load();
    onMutated?.();
  }

  if (state === "error") {
    return (
      <PageError
        onRetry={() => {
          void load();
        }}
      />
    );
  }
  if (!detail) {
    return (
      <Card>
        <p role="status" className="text-sm font-medium text-steel">
          {ko.common.loading}
        </p>
      </Card>
    );
  }

  const S = supportSloStrings();
  const target =
    S.settings.targets[sloRules[detail.ticket.category].escalationTarget];
  return (
    <SupportTicketDetail
      detail={detail}
      code={code}
      sloChip={sloTimerChip(detail.ticket, sloRules, nowMs)}
      escalation={{
        label: S.alerts.escalateTo(target),
        note: supportDeskStrings().escalationNote(target),
      }}
      currentUserId={currentUserId}
      canAssign={canAssign}
      canComment={canComment}
      onTransition={transition}
      onAddComment={addComment}
      onAssignSelf={assignSelf}
    />
  );
}
