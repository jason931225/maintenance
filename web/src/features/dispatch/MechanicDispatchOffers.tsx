import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import type { components } from "@maintenance/api-client-ts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { PageError } from "../../components/states/PageError";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";

type P1DispatchSummary = components["schemas"]["P1DispatchSummary"];
type DispatchResponseKind = components["schemas"]["DispatchResponseKind"];
type MyDispatchOffer = components["schemas"]["MyDispatchOffer"];
type OfferReadState = "idle" | "loading" | "error";

export interface PendingDispatchOffersLoadResult {
  items?: MyDispatchOffer[];
  status?: number;
}

export interface MechanicDispatchOffersProps {
  /** Look a dispatch up by id for the manager status-only view. */
  onLookup: (dispatchId: string) => Promise<P1DispatchSummary | undefined>;
  /** Lists only the signed-in mechanic's outstanding offers. */
  onListPendingOffers?: (
    signal: AbortSignal,
  ) => Promise<PendingDispatchOffersLoadResult>;
  /** Changes whenever the effective tenant/session authority changes. */
  sessionFence?: string;
  onRespond: (
    dispatchId: string,
    response: DispatchResponseKind,
  ) => Promise<P1DispatchSummary | undefined>;
  /** When true, hide the accept/decline buttons (managers view status only). */
  readOnly?: boolean;
}

/**
 * P1 emergency dispatch offers. A mechanic receives the authenticated,
 * person-scoped pending list directly from the generated API contract; managers
 * retain a read-only lookup for a known dispatch id. The read fence prevents an
 * old tenant/session request from rendering into a newer effective session.
 */
export function MechanicDispatchOffers({
  onLookup,
  onListPendingOffers,
  sessionFence,
  onRespond,
  readOnly = false,
}: MechanicDispatchOffersProps) {
  const t = ko.dispatch.offers;
  const [dispatchId, setDispatchId] = useState("");
  const [summary, setSummary] = useState<P1DispatchSummary | undefined>(
    undefined,
  );
  const [offers, setOffers] = useState<MyDispatchOffer[]>([]);
  const [offersState, setOffersState] = useState<OfferReadState>("idle");
  const [offersErrorStatus, setOffersErrorStatus] = useState<
    number | undefined
  >(undefined);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const activeFence = useRef(sessionFence);
  const offerRequestId = useRef(0);

  useEffect(() => {
    activeFence.current = sessionFence;
  }, [sessionFence]);

  const loadOffers = useCallback(
    async (signal?: AbortSignal) => {
      if (readOnly || !onListPendingOffers) return;
      const requestId = ++offerRequestId.current;
      setOffersState("loading");
      setOffersErrorStatus(undefined);
      let result: PendingDispatchOffersLoadResult;
      try {
        result = await onListPendingOffers(
          signal ?? new AbortController().signal,
        );
      } catch {
        result = {};
      }
      if (signal?.aborted || requestId !== offerRequestId.current) return;
      if (!result.items) {
        setOffers([]);
        setOffersErrorStatus(result.status);
        setOffersState("error");
        return;
      }
      setOffers(result.items);
      setOffersState("idle");
    },
    [onListPendingOffers, readOnly],
  );

  useEffect(() => {
    if (readOnly || !onListPendingOffers) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => loadOffers(controller.signal));
    return () => {
      controller.abort();
    };
  }, [loadOffers, onListPendingOffers, readOnly, sessionFence]);

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

  async function handleRespond(
    dispatchIdToRespond: string,
    response: DispatchResponseKind,
  ) {
    const requestFence = activeFence.current;
    setPending(true);
    setFeedback(undefined);
    setError(undefined);
    const result = await onRespond(dispatchIdToRespond, response);
    if (activeFence.current !== requestFence) return;
    setPending(false);
    if (!result) {
      setError(t.actionFailed);
      return;
    }
    setSummary(result);
    setOffers((current) =>
      current.filter((offer) => offer.dispatch_id !== dispatchIdToRespond),
    );
    setFeedback(response === "ACCEPT" ? t.acceptDone : t.declineDone);
  }

  const rendersPendingQueue = !readOnly && Boolean(onListPendingOffers);

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">
          {rendersPendingQueue ? t.pendingDescription : t.description}
        </p>
      </div>

      {rendersPendingQueue ? (
        <section className="grid gap-3" aria-label={t.pendingListLabel}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">{t.pendingTitle}</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={offersState === "loading" || pending}
              onClick={() => {
                void loadOffers();
              }}
            >
              {t.refresh}
            </Button>
          </div>
          {offersState === "loading" ? (
            <p role="status" className="text-sm text-steel">
              {t.loading}
            </p>
          ) : null}
          {offersState === "error" ? (
            <PageError
              status={offersErrorStatus}
              message={t.loadFailed}
              onRetry={() => {
                void loadOffers();
              }}
            />
          ) : null}
          {offersState === "idle" && offers.length === 0 ? (
            <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
              {t.pendingEmpty}
            </p>
          ) : null}
          {offersState === "idle"
            ? offers.map((offer) => (
                <div
                  key={offer.dispatch_id}
                  className="grid gap-3 rounded-md border border-line p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      to={`/work-orders/${offer.work_order_id}`}
                      className="font-semibold tabular-nums text-ink underline-offset-2 hover:underline focus-visible:underline"
                    >
                      {offer.request_no}
                    </Link>
                    <Badge>{t.statusLabels.BROADCASTING}</Badge>
                  </div>
                  <p className="text-sm text-steel">
                    {t.acceptWindow}:{" "}
                    {formatKoreanDateTime(offer.accept_window_ends_at)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        void handleRespond(offer.dispatch_id, "ACCEPT");
                      }}
                    >
                      {pending ? t.responding : t.accept}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        void handleRespond(offer.dispatch_id, "DECLINE");
                      }}
                    >
                      {pending ? t.responding : t.decline}
                    </Button>
                  </div>
                </div>
              ))
            : null}
        </section>
      ) : (
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
      )}

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

      {!rendersPendingQueue && summary ? (
        <div className="grid gap-3 rounded-md border border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-steel">{t.status}</span>
            <Badge>{t.statusLabels[summary.status]}</Badge>
          </div>
          <div className="grid gap-1 text-sm text-steel">
            <span>
              {t.acceptWindow}:{" "}
              {formatKoreanDateTime(summary.accept_window_ends_at)}
            </span>
            <span>
              {t.accepted}: {summary.accepted_count} · {t.declined}:{" "}
              {summary.declined_count}
            </span>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
