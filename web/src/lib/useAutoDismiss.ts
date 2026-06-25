import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Default auto-dismiss windows. Success messages clear quickly (they only
 * confirm a completed action); errors linger longer so a user who looked away
 * still catches them, and they can always be dismissed by hand.
 */
export const SUCCESS_DISMISS_MS = 4000;
export const ERROR_DISMISS_MS = 6000;

/**
 * Clear a transient feedback value after `ms` once it becomes truthy.
 *
 * Keeps the existing `useState` feedback pattern intact — the caller still owns
 * the state and sets it as before — but guarantees the message does not linger
 * forever (the never-auto-dismissing `<p role="status">` defect). Each new value
 * restarts the timer; clearing the value (or unmounting) cancels it.
 *
 * `ms <= 0` disables auto-dismiss (the value persists until cleared by hand).
 */
export function useAutoDismiss(
  value: unknown,
  clear: () => void,
  ms: number,
): void {
  // Hold the latest `clear` in a ref so changing its identity between renders
  // never restarts the timer — only a new `value` (or `ms`) does. The ref is
  // synced in an effect (never during render) to satisfy the rules of refs.
  const clearRef = useRef(clear);
  useEffect(() => {
    clearRef.current = clear;
  }, [clear]);

  useEffect(() => {
    if (value == null || value === "" || ms <= 0) return;
    const handle = window.setTimeout(() => {
      clearRef.current();
    }, ms);
    return () => {
      window.clearTimeout(handle);
    };
  }, [value, ms]);
}

export interface FeedbackState {
  /** Current success message, if any. */
  feedback: string | undefined;
  /** Current error message, if any. */
  error: string | undefined;
  /** Show a success message (auto-clears after `SUCCESS_DISMISS_MS`). */
  showFeedback: (message: string) => void;
  /** Show an error message (auto-clears after `ERROR_DISMISS_MS`). */
  showError: (message: string) => void;
  /** Clear the success message immediately. */
  clearFeedback: () => void;
  /** Clear the error message immediately. */
  clearError: () => void;
  /** Clear both messages immediately. */
  reset: () => void;
}

/**
 * Self-dismissing success/error feedback for a panel or form.
 *
 * One consistent source of truth for the two transient banners every console
 * surface shows after a mutation. Success and error are tracked separately so a
 * success never masks a stale error; both auto-clear (success fast, error slow)
 * and can be dismissed by hand. Pair with `<FeedbackBanner>` to render them
 * accessibly (`aria-live` status/alert regions).
 */
export function useFeedback(): FeedbackState {
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const clearFeedback = useCallback(() => {
    setFeedback(undefined);
  }, []);
  const clearError = useCallback(() => {
    setError(undefined);
  }, []);

  const showFeedback = useCallback((message: string) => {
    // A new success supersedes any lingering error.
    setError(undefined);
    setFeedback(message);
  }, []);
  const showError = useCallback((message: string) => {
    // A new error supersedes any lingering success — never show both banners.
    setFeedback(undefined);
    setError(message);
  }, []);

  const reset = useCallback(() => {
    setFeedback(undefined);
    setError(undefined);
  }, []);

  useAutoDismiss(feedback, clearFeedback, SUCCESS_DISMISS_MS);
  useAutoDismiss(error, clearError, ERROR_DISMISS_MS);

  return {
    feedback,
    error,
    showFeedback,
    showError,
    clearFeedback,
    clearError,
    reset,
  };
}
