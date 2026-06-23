import { Button } from "../ui/button";
import { ko } from "../../i18n/ko";

interface LoadMoreButtonProps {
  /** Fetches and appends the next page. */
  onClick: () => void;
  /** Disables the button and shows a busy label while the next page loads. */
  isLoading?: boolean;
  /** Records already loaded (for the accessible loaded-of-total label). */
  loaded: number;
  /** Total records available, when the API reports one. */
  total?: number;
  /** Unit suffix for the count (defaults to ko.common.countUnit). */
  unit?: string;
}

/**
 * Accessible "load more" control for paginated lists. Fetches the next page and
 * appends it. The visible label is short; the full count context lives in an
 * aria-label so screen-reader users hear how much is loaded vs. available.
 */
export function LoadMoreButton({
  onClick,
  isLoading = false,
  loaded,
  total,
  unit = ko.common.countUnit,
}: LoadMoreButtonProps) {
  const ariaLabel =
    total !== undefined
      ? ko.common.loadMoreAria
          .replace("{loaded}", String(loaded))
          .replace("{total}", String(total))
          .replaceAll("{unit}", unit)
      : ko.common.loadMore;

  return (
    <div className="flex justify-center">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={isLoading}
        aria-busy={isLoading}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {isLoading ? ko.common.loadingMore : ko.common.loadMore}
      </Button>
    </div>
  );
}
