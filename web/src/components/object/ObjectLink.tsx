import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";

import { cn, safeLabel } from "../../lib/utils";

type LinkProps = ComponentProps<typeof Link>;

interface ObjectLinkProps
  extends Omit<LinkProps, "aria-label" | "children" | "className"> {
  /** Human object type shown to assistive tech, e.g. "장비" or "작업지시". */
  objectTypeLabel: string;
  /** Human object label. Raw UUID-looking labels are suppressed by safeLabel. */
  objectLabel?: string | null;
  /** Final non-sensitive fallback when no human label is available. */
  fallbackLabel?: string;
  /** Optional visual label; the accessible label still includes the object label. */
  children?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

/**
 * Link to a first-class business object without leaking raw backend identifiers.
 *
 * Object views and list actions should route through this wrapper instead of
 * hand-building `Link` labels from `{name ?? id}` patterns. It keeps the visual
 * link flexible while making the accessible name deterministic and human-safe.
 */
export function ObjectLink({
  objectTypeLabel,
  objectLabel,
  fallbackLabel,
  children,
  ariaLabel,
  className,
  ...props
}: ObjectLinkProps) {
  const resolvedLabel = safeLabel(objectLabel, fallbackLabel);

  return (
    <Link
      {...props}
      aria-label={ariaLabel ?? `${objectTypeLabel}: ${resolvedLabel}`}
      className={cn(
        "inline-flex items-center rounded-md text-sm font-medium text-signal underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        className,
      )}
    >
      {children ?? resolvedLabel}
    </Link>
  );
}
