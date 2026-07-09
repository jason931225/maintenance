// A decision/finalization happens inside the pinned run-detail panel, which is a
// separate component tree from the 결재함/상신함 lists. This tiny window-event bus
// lets the panel tell the screen to reload after a mutation (the read cache is
// already invalidated on the POST; this just re-triggers the fetch). Mirrors the
// emitConsoleToast window-event pattern.

const APPROVALS_CHANGED_EVENT = "mnt:approvals-changed";

export function emitApprovalsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(APPROVALS_CHANGED_EVENT));
}

export function onApprovalsChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(APPROVALS_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener(APPROVALS_CHANGED_EVENT, listener);
  };
}
