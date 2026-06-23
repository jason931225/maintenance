import { RefreshCw } from "lucide-react";

import { Button } from "../ui/button";
import { ko } from "../../i18n/ko";

interface PageErrorProps {
  /** Optional override for the error message. */
  message?: string;
  /**
   * The HTTP status of the failed request, when known. On 403 the error is a
   * permission denial — retrying is futile, so the component shows a permission
   * message and hides the retry button regardless of `onRetry`. Any other status
   * (transient / 5xx / network) keeps the retry affordance.
   */
  status?: number;
  onRetry?: () => void;
}

/** Shared error state with an optional retry action. */
export function PageError({ message, status, onRetry }: PageErrorProps) {
  // A 403 means the caller lacks permission, not a transient failure: surface a
  // permission message and never offer retry (which would only 403 again).
  const isForbidden = status === 403;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-700">
        {message ?? (isForbidden ? ko.page.permissionDenied : ko.page.loadFailed)}
      </p>
      {isForbidden ? (
        <p className="mt-1 text-sm text-red-700">
          {ko.page.permissionDeniedHint}
        </p>
      ) : null}
      {onRetry && !isForbidden ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={onRetry}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {ko.page.retry}
        </Button>
      ) : null}
    </div>
  );
}
