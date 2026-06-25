import { cn } from "../../lib/utils";
import { ko } from "../../i18n/ko";

/**
 * A single shimmering placeholder block. Decorative — the surrounding loading
 * region owns the `aria-busy`/`role="status"` semantics so screen readers hear
 * one "loading" announcement, not one per bar.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded bg-muted-panel", className)}
    />
  );
}

interface SkeletonTableProps {
  /** Placeholder body rows. */
  rows?: number;
  /** Placeholder columns per row. */
  cols?: number;
  className?: string;
}

/**
 * Loading placeholder for a table surface: a header strip plus `rows × cols`
 * shimmer cells, matching the bordered-card table styling. Wrap a list/table
 * fetch in this while data loads so a blank render is never mistaken for "no
 * data". The whole block is a single polite `role="status"` region.
 */
export function SkeletonTable({
  rows = 5,
  cols = 4,
  className,
}: SkeletonTableProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={ko.page.loading}
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-white",
        className,
      )}
    >
      <div className="flex gap-3 border-b border-line bg-muted-panel/40 px-4 py-3">
        {Array.from({ length: cols }).map((_, col) => (
          <Skeleton key={col} className="h-4 flex-1" />
        ))}
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, row) => (
          <div key={row} className="flex items-center gap-3 px-4 py-3">
            {Array.from({ length: cols }).map((_, col) => (
              <Skeleton
                key={col}
                className={cn("h-4 flex-1", col === 0 && "max-w-[40%]")}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface SkeletonCardsProps {
  /** Number of card placeholders. */
  count?: number;
  /** Lines of shimmer text inside each card. */
  lines?: number;
  className?: string;
}

/**
 * Loading placeholder for a grid/list of cards (dashboards, panels): `count`
 * card-shaped blocks each with a title bar and a few text lines, matching the
 * `Card` styling. One polite `role="status"` region for the whole group.
 */
export function SkeletonCards({
  count = 3,
  lines = 2,
  className,
}: SkeletonCardsProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={ko.page.loading}
      className={cn("grid gap-3", className)}
    >
      {Array.from({ length: count }).map((_, card) => (
        <div
          key={card}
          className="grid gap-3 rounded-xl border border-line bg-white p-4"
        >
          <Skeleton className="h-5 w-1/3" />
          {Array.from({ length: lines }).map((_, line) => (
            <Skeleton
              key={line}
              className={cn("h-4", line === lines - 1 ? "w-2/3" : "w-full")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
