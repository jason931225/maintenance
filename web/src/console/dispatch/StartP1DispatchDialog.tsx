import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { DispatchApiError, isDispatchAccessDenied, type P1DispatchSummary } from "./dispatchApi";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export function StartP1DispatchDialog({
  requestNo,
  onCancel,
  onConfirm,
}: {
  requestNo: string;
  onCancel: () => void;
  onConfirm: () => Promise<P1DispatchSummary>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<"confirm" | "submitting" | "started" | "denied" | "conflict" | "error">("confirm");
  const [summary, setSummary] = useState<P1DispatchSummary | null>(null);
  const busy = state === "submitting";

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const inerted = Array.from(document.body.children).filter((child) => child !== surfaceRef.current?.parentElement).map((child) => ({
      child,
      ariaHidden: child.getAttribute("aria-hidden"),
      inert: (child as HTMLElement).inert,
    }));
    inerted.forEach(({ child }) => { child.setAttribute("aria-hidden", "true"); (child as HTMLElement).inert = true; });
    confirmRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !surfaceRef.current) return;
      const focusable = focusableWithin(surfaceRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        surfaceRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = priorOverflow;
      inerted.forEach(({ child, ariaHidden, inert }) => {
        if (ariaHidden === null) child.removeAttribute("aria-hidden"); else child.setAttribute("aria-hidden", ariaHidden);
        (child as HTMLElement).inert = inert;
      });
      returnFocusRef.current?.focus();
    };
  }, [busy, onCancel]);

  async function confirm() {
    if (busy) return;
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

  return createPortal(
    <div className="dispatch-console__dialog-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <section ref={surfaceRef} className="dispatch-console__dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
        <h2 id={titleId}>Start P1 emergency broadcast</h2>
        {state === "started" && summary ? (
          <>
            <p id={descriptionId}>Broadcast started for {requestNo}.</p>
            <dl className="dispatch-console__dialog-facts">
              <div><dt>Dispatch status</dt><dd>{summary.status}</dd></div>
              <div><dt>Accept window ends</dt><dd>{summary.accept_window_ends_at}</dd></div>
              <div><dt>Requested mechanics</dt><dd>{summary.target_count}</dd></div>
            </dl>
            <button type="button" ref={confirmRef} onClick={onCancel}>Close</button>
          </>
        ) : (
          <>
            <p id={descriptionId}>This sends the emergency broadcast for {requestNo}. No incident location or regional expansion will be inferred.</p>
            {state === "denied" && <p className="dispatch-console__dialog-error" role="alert">Your current role is not authorized to start this broadcast.</p>}
            {state === "conflict" && <p className="dispatch-console__dialog-error" role="alert">This work order already has a P1 dispatch. Refresh the queue and choose its current state.</p>}
            {state === "error" && <p className="dispatch-console__dialog-error" role="alert">The P1 broadcast was not started. You can try again without changing this work order.</p>}
            <div className="dispatch-console__dialog-actions">
              <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
              <button type="button" ref={confirmRef} className="dispatch-console__primary-action" onClick={() => { void confirm(); }} disabled={busy}>
                {busy ? "Starting broadcast…" : "Confirm P1 broadcast"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
