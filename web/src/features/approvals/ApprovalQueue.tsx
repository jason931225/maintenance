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
  onApprove: (workOrderId: string) => Promise<void>;
  onReject: (workOrderId: string, memo: string) => Promise<void>;
}

export function ApprovalQueue({
  workOrders,
  onApprove,
  onReject,
}: ApprovalQueueProps) {
  const [memo, setMemo] = useState("");
  const [memoError, setMemoError] = useState<string | undefined>();
  const pending = workOrders.filter(
    (workOrder) =>
      workOrder.status === "REPORT_SUBMITTED" ||
      workOrder.status === "ADMIN_REVIEW",
  );

  return (
    <Card className="grid gap-4">
      <h2 className="text-lg font-semibold text-slate-950">{ko.approvals.title}</h2>
      <div className="grid gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="approval-memo">
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
        />
        {memoError ? (
          <p className="text-sm font-medium text-red-700">{memoError}</p>
        ) : null}
      </div>
      {pending.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          {ko.approvals.empty}
        </p>
      ) : null}
      <div className="grid gap-3">
        {pending.map((workOrder) => (
          <article
            key={workOrder.id}
            className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-[1fr_auto]"
          >
            <div>
              <p className="font-semibold text-slate-950">{workOrder.request_no}</p>
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
                onClick={() => {
                  void onApprove(workOrder.id);
                }}
                aria-label={`${workOrder.request_no} ${ko.approvals.approve}`}
              >
                <Check aria-hidden="true" size={18} />
                {ko.approvals.approve}
              </Button>
              <Button
                type="button"
                variant="secondary"
                aria-label={`${workOrder.request_no} ${ko.approvals.reject}`}
                onClick={() => {
                  const trimmedMemo = memo.trim();
                  if (!trimmedMemo) {
                    setMemoError(ko.approvals.requiredRejectMemo);
                    return;
                  }
                  void onReject(workOrder.id, trimmedMemo);
                }}
              >
                <X aria-hidden="true" size={18} />
                {ko.approvals.reject}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </Card>
  );
}
