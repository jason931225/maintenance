import { useState } from "react";

import type { components } from "@maintenance/api-client-ts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { ko } from "../../i18n/ko";

type P1DispatchSummary = components["schemas"]["P1DispatchSummary"];
type DispatchResponseKind = components["schemas"]["DispatchResponseKind"];

export interface MechanicDispatchOffersProps {
  /** Look a dispatch up by id (the id delivered in the FCM push payload). */
  onLookup: (dispatchId: string) => Promise<P1DispatchSummary | undefined>;
  onRespond: (
    dispatchId: string,
    response: DispatchResponseKind,
  ) => Promise<P1DispatchSummary | undefined>;
  /** When true, hide the accept/decline buttons (managers view status only). */
  readOnly?: boolean;
}

/**
 * Desk-based view of a P1 emergency dispatch offer with accept/decline buttons.
 * There is no "list my pending dispatches" endpoint, so the mechanic loads an
 * offer by the dispatch id carried in the push notification, then responds via
 * `/responses`. Managers can view status without the action buttons.
 */
export function MechanicDispatchOffers({
  onLookup,
  onRespond,
  readOnly = false,
}: MechanicDispatchOffersProps) {
  const t = ko.dispatch.offers;

  const [dispatchId, setDispatchId] = useState("");
  const [summary, setSummary] = useState<P1DispatchSummary | undefined>(
    undefined,
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleLookup() {
    setFeedback(undefined);
    setError(undefined);
    if (!dispatchId.trim()) return;
    setPending(true);
    const result = await onLookup(dispatchId.trim());
    setPending(false);
    if (!result) {
      setSummary(undefined);
      setError(t.notFound);
      return;
    }
    setSummary(result);
  }

  async function handleRespond(response: DispatchResponseKind) {
    if (!summary) return;
    setPending(true);
    setFeedback(undefined);
    setError(undefined);
    const result = await onRespond(summary.id, response);
    setPending(false);
    if (!result) {
      setError(t.actionFailed);
      return;
    }
    setSummary(result);
    setFeedback(response === "ACCEPT" ? t.acceptDone : t.declineDone);
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
          htmlFor="dispatch-lookup"
        >
          {t.lookupLabel}
        </label>
        <div className="flex gap-2">
          <Input
            id="dispatch-lookup"
            aria-label={t.lookupLabel}
            placeholder={t.lookupPlaceholder}
            value={dispatchId}
            onChange={(event) => {
              setDispatchId(event.target.value);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !dispatchId.trim()}
            onClick={() => {
              void handleLookup();
            }}
          >
            {t.lookup}
          </Button>
        </div>
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

      {summary ? (
        <div className="grid gap-3 rounded-md border border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-steel">
              {t.status}
            </span>
            <Badge>{t.statusLabels[summary.status]}</Badge>
          </div>
          <div className="grid gap-1 text-sm text-steel">
            <span>
              {t.acceptWindow}: {formatIsoDateTime(summary.accept_window_ends_at)}
            </span>
            <span>
              {t.accepted}: {summary.accepted_count} · {t.declined}:{" "}
              {summary.declined_count}
            </span>
          </div>
          {!readOnly && summary.status === "BROADCASTING" ? (
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  void handleRespond("ACCEPT");
                }}
              >
                {pending ? t.responding : t.accept}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  void handleRespond("DECLINE");
                }}
              >
                {pending ? t.responding : t.decline}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function formatIsoDateTime(value: string) {
  return value.slice(0, 16).replace("T", " ");
}
