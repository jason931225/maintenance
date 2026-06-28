import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { WorkOrderDetail as WorkOrderDetailData } from "../../api/types";
import type { WorkOrderListItem } from "../../api/types";
import { useAuth } from "../../context/auth";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { FeedbackBanner } from "../../components/states/FeedbackBanner";
import { PageError } from "../../components/states/PageError";
import { SkeletonCards } from "../../components/states/Skeleton";
import { ko } from "../../i18n/ko";
import {
  ERROR_DISMISS_MS,
  SUCCESS_DISMISS_MS,
  useAutoDismiss,
} from "../../lib/useAutoDismiss";
import { cn, priorityClass, priorityLabel } from "../../lib/utils";
import { WorkOrderDetail } from "../dispatch/WorkOrderDetail";

interface ApprovalQueueProps {
  workOrders: WorkOrderListItem[];
  focusedWorkOrderId?: string;
  onApprove: (workOrderId: string) => Promise<boolean>;
  onReject: (workOrderId: string, memo: string) => Promise<boolean>;
}

/** The order the per-order reject dialog is scoped to (carries its own memo). */
interface RejectTarget {
  id: string;
  requestNo: string;
}

export function ApprovalQueue({
  workOrders,
  focusedWorkOrderId,
  onApprove,
  onReject,
}: ApprovalQueueProps) {
  // The currently approving order id (locks every action while in flight).
  const [approving, setApproving] = useState<string | undefined>();
  // The order whose reject dialog is open, plus that dialog's own memo. Scoping
  // the memo to this single target makes it impossible to reject order B with a
  // memo that was typed for order A.
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | undefined>();
  const [rejectMemo, setRejectMemo] = useState("");
  const [rejectMemoError, setRejectMemoError] = useState<string | undefined>();
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<"approved" | "rejected" | "error">();

  const rejectTitleId = useId();
  const rejectMessageId = useId();
  const rejectMemoId = useId();
  const rejectMemoErrorId = useId();
  const rejectMemoRef = useRef<HTMLTextAreaElement>(null);

  const busy = Boolean(approving) || rejecting;

  // Self-dismiss the action result: success clears fast, an error lingers a bit
  // longer so it is not missed before it disappears.
  const clearFeedback = useCallback(() => {
    setFeedback(undefined);
  }, []);
  useAutoDismiss(
    feedback,
    clearFeedback,
    feedback === "error" ? ERROR_DISMISS_MS : SUCCESS_DISMISS_MS,
  );

  const pending = workOrders.filter(
    (workOrder) =>
      workOrder.status === "REPORT_SUBMITTED" ||
      workOrder.status === "ADMIN_REVIEW",
  );
  const hasFocusedWorkOrder = Boolean(
    focusedWorkOrderId &&
      pending.some((workOrder) => workOrder.id === focusedWorkOrderId),
  );

  async function handleApprove(workOrderId: string) {
    if (busy) {
      return;
    }
    setFeedback(undefined);
    setApproving(workOrderId);
    const ok = await onApprove(workOrderId);
    setApproving(undefined);
    setFeedback(ok ? "approved" : "error");
  }

  function openRejectDialog(target: RejectTarget) {
    if (busy) {
      return;
    }
    setRejectTarget(target);
    setRejectMemo("");
    setRejectMemoError(undefined);
    setRejectError(undefined);
  }

  function closeRejectDialog() {
    if (rejecting) {
      return;
    }
    setRejectTarget(undefined);
    setRejectMemo("");
    setRejectMemoError(undefined);
    setRejectError(undefined);
  }

  async function confirmReject() {
    if (!rejectTarget || rejecting) {
      return;
    }
    const trimmedMemo = rejectMemo.trim();
    if (!trimmedMemo) {
      setRejectMemoError(ko.approvals.requiredRejectMemo);
      return;
    }
    setFeedback(undefined);
    setRejectError(undefined);
    setRejecting(true);
    // Reject the dialog's own target with its own memo — never another order's.
    const ok = await onReject(rejectTarget.id, trimmedMemo);
    setRejecting(false);
    if (ok) {
      setRejectTarget(undefined);
      setRejectMemo("");
      setFeedback("rejected");
    } else {
      setRejectError(ko.approvals.actionFailed);
      setFeedback("error");
    }
  }

  return (
    <Card className="grid gap-4">
      <p className="text-sm text-steel">{ko.approvals.reviewBeforeDeciding}</p>

      <FeedbackBanner
        kind={feedback === "error" ? "error" : "success"}
        message={
          feedback === "approved"
            ? ko.approvals.approved
            : feedback === "rejected"
              ? ko.approvals.rejected
              : feedback === "error"
                ? ko.approvals.actionFailed
                : undefined
        }
        onDismiss={clearFeedback}
      />

      {pending.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
          {ko.approvals.empty}
        </p>
      ) : null}

      {focusedWorkOrderId ? (
        <p
          role="status"
          className={cn(
            "rounded-md border p-3 text-sm font-medium",
            hasFocusedWorkOrder
              ? "border-brand-teal bg-brand-teal/10 text-brand-teal"
              : "border-amber-300 bg-amber-50 text-amber-900",
          )}
        >
          {hasFocusedWorkOrder
            ? ko.approvals.focusedDeepLink
            : ko.approvals.focusedMissing}
        </p>
      ) : null}

      <div className="grid gap-3">
        {pending.map((workOrder) => (
          <ApprovalRow
            key={workOrder.id}
            workOrder={workOrder}
            isFocused={workOrder.id === focusedWorkOrderId}
            busy={busy}
            approving={approving === workOrder.id}
            onApprove={() => {
              void handleApprove(workOrder.id);
            }}
            onReject={() => {
              openRejectDialog({
                id: workOrder.id,
                requestNo: workOrder.request_no,
              });
            }}
          />
        ))}
      </div>

      {/* Per-order reject dialog (destructive). Scoped to a single order with its
          own required memo, built on the Dialog primitive so the memo lives in
          the dialog — a memo can never be carried to another order. */}
      <Dialog
        open={Boolean(rejectTarget)}
        onClose={closeRejectDialog}
        titleId={rejectTitleId}
        describedById={rejectMessageId}
        initialFocusRef={rejectMemoRef}
        closeOnScrimClick={!rejecting}
      >
        <div className="grid gap-1">
          <h2 id={rejectTitleId} className="text-lg font-semibold text-ink">
            {ko.approvals.rejectTitle}
          </h2>
          <p id={rejectMessageId} className="text-sm text-steel">
            {rejectTarget ? (
              <>
                <span className="font-semibold text-ink">
                  {rejectTarget.requestNo}
                </span>
                {" — "}
                {ko.approvals.rejectMessage}
              </>
            ) : (
              ko.approvals.rejectMessage
            )}
          </p>
        </div>

        <div className="grid gap-2">
          <label
            className="text-sm font-medium text-steel"
            htmlFor={rejectMemoId}
          >
            {ko.approvals.rejectMemoLabel}
          </label>
          <Textarea
            id={rejectMemoId}
            ref={rejectMemoRef}
            rows={3}
            value={rejectMemo}
            placeholder={ko.approvals.rejectMemoPlaceholder}
            disabled={rejecting}
            aria-invalid={Boolean(rejectMemoError)}
            aria-describedby={rejectMemoError ? rejectMemoErrorId : undefined}
            onChange={(event) => {
              setRejectMemo(event.currentTarget.value);
              setRejectMemoError(undefined);
            }}
          />
          {rejectMemoError ? (
            <p
              id={rejectMemoErrorId}
              role="alert"
              className="text-sm font-medium text-red-700"
            >
              {rejectMemoError}
            </p>
          ) : null}
        </div>

        {rejectError ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {rejectError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={rejecting}
            onClick={closeRejectDialog}
          >
            {ko.common.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={rejecting}
            onClick={() => {
              void confirmReject();
            }}
          >
            {rejecting ? ko.approvals.rejecting : ko.approvals.rejectConfirm}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

interface ApprovalRowProps {
  workOrder: WorkOrderListItem;
  isFocused?: boolean;
  /** Any action is in flight (locks approve/reject across the whole queue). */
  busy: boolean;
  /** This specific order is being approved. */
  approving: boolean;
  onApprove: () => void;
  onReject: () => void;
}

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; detail: WorkOrderDetailData }
  | { status: "error" };

/**
 * One queue item. The approver expands the row to read the full work-order
 * report — diagnosis, action_taken, result_type, symptom/customer_request,
 * status history and evidence thumbnails — fetched lazily from GET
 * /api/v1/work-orders/{id} only when the row is opened. The embedded
 * {@link WorkOrderDetail} renders read-only here (`canAct`/`canUploadEvidence`
 * false), so the approval surface never gains the mechanic write controls. The
 * approver therefore decides WITH the work in view, never blind.
 */
function ApprovalRow({
  workOrder,
  isFocused = false,
  busy,
  approving,
  onApprove,
  onReject,
}: ApprovalRowProps) {
  const { api } = useAuth();
  const rowRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });

  useEffect(() => {
    if (!isFocused) {
      return;
    }
    const row = rowRef.current;
    if (!row) {
      return;
    }
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    row.focus({ preventScroll: true });
  }, [isFocused]);

  const loadDetail = useCallback(async () => {
    setDetail({ status: "loading" });
    const response = await api
      .GET("/api/v1/work-orders/{workOrderId}", {
        params: { path: { workOrderId: workOrder.id } },
      })
      .catch(() => undefined);
    if (response?.data) {
      setDetail({ status: "ready", detail: response.data });
    } else {
      setDetail({ status: "error" });
    }
  }, [api, workOrder.id]);

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    // Lazy-fetch the detail the first time the row is opened (or after an error).
    if (next && detail.status !== "ready") {
      void loadDetail();
    }
  }

  const detailRegionId = `approval-detail-${workOrder.id}`;

  return (
    <article
      ref={rowRef}
      id={`approval-work-order-${workOrder.id}`}
      tabIndex={isFocused ? -1 : undefined}
      aria-current={isFocused ? "true" : undefined}
      aria-label={
        isFocused
          ? `${workOrder.request_no} ${ko.approvals.focusedItemLabel}`
          : undefined
      }
      className={cn(
        "grid gap-3 rounded-md border border-line p-3",
        isFocused && "border-brand-teal bg-brand-teal/10 ring-2 ring-brand-teal/40",
      )}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <p className="font-semibold text-ink">{workOrder.request_no}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge>{ko.status[workOrder.status]}</Badge>
            <Badge className={priorityClass(workOrder.priority)}>
              {priorityLabel(workOrder.priority)}
            </Badge>
            <Badge>{workOrder.equipment.model ?? ko.common.unknown}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={detailRegionId}
            aria-label={`${workOrder.request_no} ${
              expanded ? ko.approvals.hideReport : ko.approvals.viewReport
            }`}
            onClick={toggleExpanded}
          >
            {expanded ? (
              <ChevronUp aria-hidden="true" size={18} />
            ) : (
              <ChevronDown aria-hidden="true" size={18} />
            )}
            {expanded ? ko.approvals.hideReport : ko.approvals.viewReport}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={onApprove}
            aria-label={`${workOrder.request_no} ${ko.approvals.approve}`}
          >
            <Check aria-hidden="true" size={18} />
            {approving ? ko.approvals.approving : ko.approvals.approve}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onReject}
            aria-label={`${workOrder.request_no} ${ko.approvals.reject}`}
          >
            <X aria-hidden="true" size={18} />
            {ko.approvals.reject}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div id={detailRegionId} className="border-t border-line pt-3">
          {detail.status === "loading" ? (
            <SkeletonCards count={2} lines={3} />
          ) : null}
          {detail.status === "error" ? (
            <PageError
              message={ko.approvals.reportLoadFailed}
              onRetry={() => {
                void loadDetail();
              }}
            />
          ) : null}
          {detail.status === "ready" ? (
            <WorkOrderDetail
              workOrder={detail.detail}
              canAct={false}
              canUploadEvidence={false}
              onStartWork={noopStart}
              onSubmitReport={noopReport}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// Read-only embed: the write controls are gated off (`canAct` false) so these
// never fire, but WorkOrderDetail's prop contract still requires the handlers.
function noopStart(): Promise<boolean> {
  return Promise.resolve(false);
}
function noopReport(): Promise<boolean> {
  return Promise.resolve(false);
}
