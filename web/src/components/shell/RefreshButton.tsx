import { RefreshCw } from "lucide-react";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { ko } from "../../i18n/ko";

interface RefreshButtonProps {
  onClick: () => void;
  isLoading?: boolean;
}

/** Page-header refresh action with a busy/disabled state while refetching. */
export function RefreshButton({ onClick, isLoading = false }: RefreshButtonProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={isLoading}
      aria-busy={isLoading}
      onClick={onClick}
    >
      <RefreshCw
        size={16}
        aria-hidden="true"
        className={cn(isLoading && "animate-spin")}
      />
      {ko.page.refresh}
    </Button>
  );
}
