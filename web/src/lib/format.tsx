import type * as React from "react";

import { ko } from "../i18n/ko";
import { formatWonAmount } from "./currency";
import { cn } from "./utils";

/** Console typography primitive for identifiers, dates, counters, and money. */
export function Mono({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("font-mono tabular-nums tracking-tight", className)}
      {...props}
    />
  );
}

interface WonProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  amount: number;
  unitClassName?: string;
}

/** Localized won renderer: tabular mono digits + the i18n currency unit. */
export function Won({ amount, className, unitClassName, ...props }: WonProps) {
  const formatted = formatWonAmount(amount);
  const label = `${formatted} ${ko.financial.wonUnit}`;
  return (
    <span
      aria-label={label}
      className={cn("inline-flex items-baseline gap-1", className)}
      {...props}
    >
      <Mono>{formatted}</Mono>{" "}
      <span className={unitClassName}>{ko.financial.wonUnit}</span>
    </span>
  );
}
