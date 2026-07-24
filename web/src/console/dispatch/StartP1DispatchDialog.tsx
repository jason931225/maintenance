import { useEffect, useRef, useState } from "react";

import { DispatchApiError, isDispatchAccessDenied, type P1DispatchSummary } from "./dispatchApi";

export function StartP1DispatchDialog({
  requestNo,
  onCancel,
  onConfirm,
}: {
  requestNo: string;
  onCancel: () => void;
  onConfirm: () => Promise<P1DispatchSummary>;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<"confirm" | "submitting" | "started" | "denied" | "conflict" | "error">("confirm");
  const [summary, setSummary] = useState<P1DispatchSummary | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  async function confirm() {
    if (state === "submitting") return;
    setState("submitting");
    try {
      setSummary(await onConfirm());
      setState("started");
    } catch (error: unknown) {
      if (isDispatchAccessDenied(error)) setState("denied");
      else if (error instanceof DispatchApiError && error.status === 409) setState("conflict");
      else setState("error");
    }
  }

  return (
    <div className="dispatch-console__dialog-backdrop" role="presentation">
      <section className="dispatch-console__dialog" role="dialog" aria-modal="true" aria-labelledby="start-p1-dialog-title" aria-describedby="start-p1-dialog-description">
        <h2 id="start-p1-dialog-title">Start P1 emergency broadcast</h2>
        {state === "started" && summary ? (
          <>
            <p id="start-p1-dialog-description">Broadcast started for {requestNo}.</p>
            <dl className="dispatch-console__dialog-facts">
              <div><dt>Dispatch status</dt><dd>{summary.status}</dd></div>
              <div><dt>Accept window ends</dt><dd>{summary.accept_window_ends_at}</dd></div>
              <div><dt>Requested mechanics</dt><dd>{summary.target_count}</dd></div>
            </dl>
            <button type="button" ref={confirmRef} onClick={onCancel}>Close</button>
          </>
        ) : (
          <>
            <p id="start-p1-dialog-description">This sends the emergency broadcast for {requestNo}. No incident location or regional expansion will be inferred.</p>
            {state === "denied" && <p className="dispatch-console__dialog-error" role="alert">Your current role is not authorized to start this broadcast.</p>}
            {state === "conflict" && <p className="dispatch-console__dialog-error" role="alert">This work order already has a P1 dispatch. Refresh the queue and choose its current state.</p>}
            {state === "error" && <p className="dispatch-console__dialog-error" role="alert">The P1 broadcast was not started. You can try again without changing this work order.</p>}
            <div className="dispatch-console__dialog-actions">
              <button type="button" onClick={onCancel} disabled={state === "submitting"}>Cancel</button>
              <button type="button" ref={confirmRef} className="dispatch-console__primary-action" onClick={() => { void confirm(); }} disabled={state === "submitting"}>
                {state === "submitting" ? "Starting broadcast…" : "Confirm P1 broadcast"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
