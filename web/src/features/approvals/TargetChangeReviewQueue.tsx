import { useState } from "react";

import type {
  TargetChangeDecision,
  TargetChangeRequestSummary,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";

export interface TargetChangeReviewQueueProps {
  /**
   * Review a target due-date change request by id. There is no list/get endpoint
   * for these (managers create them from the dispatch controls and carry the id
   * forward), so the reviewer acts on the id directly, mirroring the P1 dispatch
   * offers panel. Returns the updated summary, or undefined on failure.
   */
  onReview: (
    requestId: string,
    decision: TargetChangeDecision,
    memo: string,
  ) => Promise<TargetChangeRequestSummary | undefined>;
}

/**
 * Admin review surface for target due-date change requests: enter the request id,
 * then approve or reject (with an optional memo). Both actions POST to
 * `/api/target-change-requests/{requestId}/review`; the backend re-checks the
 * TargetManage authorization on every call.
 */
export function TargetChangeReviewQueue({
  onReview,
}: TargetChangeReviewQueueProps) {
  const t = ko.approvals.targetChange;

  const [requestId, setRequestId] = useState("");
  const [summary, setSummary] = useState<TargetChangeRequestSummary>();
  const [memo, setMemo] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();

  async function handleReview(decision: TargetChangeDecision) {
    const id = requestId.trim();
    if (!id) return;
    setPending(true);
    setFeedback(undefined);
    setError(undefined);
    const result = await onReview(id, decision, memo.trim());
    setPending(false);
    if (!result) {
      setSummary(undefined);
      setError(t.actionFailed);
      return;
    }
    setSummary(result);
    setMemo("");
    setFeedback(decision === "APPROVED" ? t.approveDone : t.rejectDone);
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="target-change-request-id"
        >
          {t.lookupLabel}
        </label>
        <Input
          id="target-change-request-id"
          aria-label={t.lookupLabel}
          placeholder={t.lookupPlaceholder}
          value={requestId}
          onChange={(event) => {
            setRequestId(event.target.value);
          }}
        />
      </div>

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="target-change-memo"
        >
          {t.memoLabel}
        </label>
        <Textarea
          id="target-change-memo"
          aria-label={t.memoLabel}
          placeholder={t.memoPlaceholder}
          value={memo}
          onChange={(event) => {
            setMemo(event.target.value);
          }}
        />
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

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={pending || !requestId.trim()}
          onClick={() => {
            void handleReview("APPROVED");
          }}
        >
          {pending ? t.reviewing : t.approve}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending || !requestId.trim()}
          onClick={() => {
            void handleReview("REJECTED");
          }}
        >
          {pending ? t.reviewing : t.reject}
        </Button>
      </div>

      {summary ? (
        <div className="grid gap-2 rounded-md border border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-steel">
              {t.requestedTargetDueAt}
            </span>
            {summary.status ? (
              <Badge>{t.statuses[summary.status]}</Badge>
            ) : null}
          </div>
          {summary.requested_target_due_at ? (
            <span className="text-sm text-steel">
              {summary.requested_target_due_at.slice(0, 16).replace("T", " ")}
            </span>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
