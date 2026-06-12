import type * as React from "react";

import { cn } from "../../lib/utils";

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex min-h-8 items-center rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-800",
        className,
      )}
      {...props}
    />
  );
}
