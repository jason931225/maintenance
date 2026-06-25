import type * as React from "react";

import { cn } from "../../lib/utils";

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex min-h-8 items-center rounded border border-line px-2.5 py-1 text-xs font-semibold text-steel",
        className,
      )}
      {...props}
    />
  );
}
