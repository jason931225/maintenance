import { Check, X } from "lucide-react";
import { useState } from "react";

import type { WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";

interface ApprovalQueueProps {
  workOrders: WorkOrderListItem[];
  onApprove: (workOrderId: string) => Promise<boolean>;
  onReject: (workOrderId: string, memo: string) => Promise<boolean>;
}

type BusyAction = "approve" | "reject";

export function ApprovalQueue({
  workOrders,
  onApprove,
  onReject,
}: ApprovalQueueProps) {
  const [memo, setMemo] = useState("");
  const [memoError, setMemoError] = useState<string | undefined>();
  const [busy, setBusy] = useState<{ id: string; action: BusyAction }>();
  const [feedback, setFeedback] = useState<"approved" | "rejected" | "error">();
  const pending = workOrders.filter(
    (workOrder) =>
      workOrder.status === "REPORT_SUBMITTED" ||
      workOrder.status === "ADMIN_REVIEW",
  );

  async function handleApprove(workOrderId: string) {
    if (busy) {
      return;
    }
    setFeedback(undefined);
    setBusy({ id: workOrderId, action: "approve" });
    const ok = await onApprove(workOrderId);
    setBusy(undefined);
    setFeedback(ok ? "approved" : "error");
  }

  async function handleReject(workOrderId: string) {
    if (busy) {
      return;
    }
    const trimmedMemo = memo.trim();
    if (!trimmedMemo) {
      setMemoError(ko.approvals.requiredRejectMemo);
      return;
    }
    setFeedback(undefined);
    setBusy({ id: workOrderId, action: "reject" });
    const ok = await onReject(workOrderId, trimmedMemo);
    setBusy(undefined);
    setFeedback(ok ? "rejected" : "error");
  }

  return (
    <Card className="grid gap-4">
      <h2 className="text-lg font-semibold text-ink">{ko.approvals.title}</h2>
      <div className="grid gap-2">
        <label className="text-sm font-medium text-steel" htmlFor="approval-memo">
          {ko.approvals.memo}
        </label>
        <Textarea
          id="approval-memo"
          value={memo}
          onChange={(event) => {
            setMemo(event.currentTarget.value);
            setMemoError(undefined);
          }}
          aria-invalid={Boolean(memoError)}
          aria-describedby={memoError ? "approval-memo-error" : undefined}
        />
        {memoError ? (
          <p
            id="approval-memo-error"
            className="text-sm font-medium text-red-700"
          >
            {memoError}
          </p>
        ) : null}
      </div>
      {feedback === "approved" || feedback === "rejected" ? (
        <p role="status" className="text-sm font-semibold text-brand-teal">
          {feedback === "approved"
            ? ko.approvals.approved
            : ko.approvals.rejected}
        </p>
      ) : null}
      {feedback === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.approvals.actionFailed}
        </p>
      ) : null}
      {pending.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
          {ko.approvals.empty}
        </p>
      ) : null}
      <div className="grid gap-3">
        {pending.map((workOrder) => (
          <article
            key={workOrder.id}
            className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-[1fr_auto]"
          >
            <div>
              <p className="font-semibold text-ink">{workOrder.request_no}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge>{ko.status[workOrder.status]}</Badge>
                <Badge>{workOrder.priority}</Badge>
                <Badge>
                  {workOrder.equipment.model ?? ko.common.unknown}
                </Badge>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => {
                  void handleApprove(workOrder.id);
                }}
                aria-label={`${workOrder.request_no} ${ko.approvals.approve}`}
              >
                <Check aria-hidden="true" size={18} />
                {busy?.id === workOrder.id && busy.action === "approve"
                  ? ko.approvals.approving
                  : ko.approvals.approve}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={Boolean(busy)}
                aria-label={`${workOrder.request_no} ${ko.approvals.reject}`}
                onClick={() => {
                  void handleReject(workOrder.id);
                }}
              >
                <X aria-hidden="true" size={18} />
                {busy?.id === workOrder.id && busy.action === "reject"
                  ? ko.approvals.rejecting
                  : ko.approvals.reject}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </Card>
  );
}
