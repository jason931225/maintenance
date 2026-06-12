import type * as React from "react";

import { cn } from "../../lib/utils";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn("rounded-lg border border-slate-200 bg-white p-4", className)}
      {...props}
    />
  );
}
