import { X } from "lucide-react";

import { cn } from "../../lib/utils";
import { ko } from "../../i18n/ko";

type FeedbackKind = "success" | "error";

interface FeedbackBannerProps {
  /** Message to show; nothing renders when empty. */
  message: string | undefined;
  /** Tone — drives color and the `aria-live` politeness level. */
  kind: FeedbackKind;
  /** Dismiss handler; renders a keyboard-focusable close button when provided. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * Accessible, dismissible feedback banner for a single transient message.
 *
 * Success uses `role="status"` (polite) and error `role="alert"` (assertive) so
 * screen readers announce each appropriately. Pair with `useFeedback` /
 * `useAutoDismiss` so the message also clears itself after a timeout; the close
 * button lets keyboard and pointer users dismiss it immediately.
 */
export function FeedbackBanner({
  message,
  kind,
  onDismiss,
  className,
}: FeedbackBannerProps) {
  if (!message) return null;
  const isError = kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={cn(
        "flex items-start justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium",
        isError
          ? "border border-red-200 bg-red-50 text-red-700"
          : "border border-tone-success-border bg-tone-success-bg text-tone-success-text",
        className,
      )}
    >
      <span>{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={ko.page.dismiss}
          className="-mr-1 -mt-0.5 inline-flex min-h-6 min-w-6 items-center justify-center rounded text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
