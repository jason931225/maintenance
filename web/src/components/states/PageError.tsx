import { RefreshCw } from "lucide-react";

import { Button } from "../ui/button";
import { ko } from "../../i18n/ko";

interface PageErrorProps {
  /** Optional override for the error message. */
  message?: string;
  onRetry?: () => void;
}

/** Shared error state with an optional retry action. */
export function PageError({ message, onRetry }: PageErrorProps) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-700">
        {message ?? ko.page.loadFailed}
      </p>
      {onRetry ? (
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
