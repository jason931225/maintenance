import { useState } from "react";

import type {
  TargetChangeDecision,
  TargetChangeRequestSummary,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";

type ReviewableTargetChangeRequest = TargetChangeRequestSummary & {
  id: string;
  work_order_id: string;
  requested_target_due_at: string;
  status: NonNullable<TargetChangeRequestSummary["status"]>;
};

function isReviewableTargetChange(
  request: TargetChangeRequestSummary,
): request is ReviewableTargetChangeRequest {
  return Boolean(
    request.id &&
      request.work_order_id &&
      request.requested_target_due_at &&
      request.status,
  );
}

export interface TargetChangeReviewQueueProps {
  requests: TargetChangeRequestSummary[];
  onReview: (
    requestId: string,
    decision: TargetChangeDecision,
    memo: string,
  ) => Promise<TargetChangeRequestSummary | undefined>;
}

/**
 * Admin review surface for target due-date change requests. The list is loaded
 * from the federated approval API, while each decision still POSTs to the
 * source-specific review endpoint where TargetManage authorization is checked
 * again before any mutation.
 */
export function TargetChangeReviewQueue({
  requests,
  onReview,
}: TargetChangeReviewQueueProps) {
  const t = ko.approvals.targetChange;

  const [memoById, setMemoById] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const reviewableRequests = requests.filter(isReviewableTargetChange);

  async function handleReview(
    requestId: string,
    decision: TargetChangeDecision,
  ) {
    if (pendingId) return;
    setPendingId(requestId);
    setFeedback(undefined);
    setError(undefined);
    const result = await onReview(
      requestId,
      decision,
      (memoById[requestId] ?? "").trim(),
    );
    setPendingId(undefined);
    if (!result) {
      setError(t.actionFailed);
      return;
    }
    setMemoById((current) => {
      const { [requestId]: removed, ...remaining } = current;
      void removed;
      return remaining;
    });
    setFeedback(decision === "APPROVED" ? t.approveDone : t.rejectDone);
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>

      {feedback ? (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {feedback}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      {reviewableRequests.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
          {t.empty}
        </p>
      ) : (
        <ul className="grid gap-3" aria-label={t.listLabel}>
          {reviewableRequests.map((request) => {
            const pending = pendingId === request.id;
            const memoId = `target-change-memo-${request.id}`;
            return (
              <li
                key={request.id}
                id={`target-change-${request.id}`}
                className="grid gap-3 rounded-md border border-line p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-steel">
                      {t.requestedTargetDueAt}
                    </p>
                    <p className="font-semibold text-ink">
                      {formatKoreanDateTime(request.requested_target_due_at)}
                    </p>
                    <p className="mt-1 text-xs text-steel">
                      {t.workOrderLabel}: {request.work_order_id}
                    </p>
                  </div>
                  <Badge>{t.statuses[request.status]}</Badge>
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium text-steel" htmlFor={memoId}>
                    {t.memoLabel}
                  </label>
                  <Textarea
                    id={memoId}
                    aria-label={t.memoLabel}
                    placeholder={t.memoPlaceholder}
                    value={memoById[request.id] ?? ""}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setMemoById((current) => ({
                        ...current,
                        [request.id]: value,
                      }));
                    }}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={Boolean(pendingId)}
                    onClick={() => {
                      void handleReview(request.id, "APPROVED");
                    }}
                  >
                    {pending ? t.reviewing : t.approve}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={Boolean(pendingId)}
                    onClick={() => {
                      void handleReview(request.id, "REJECTED");
                    }}
                  >
                    {pending ? t.reviewing : t.reject}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
