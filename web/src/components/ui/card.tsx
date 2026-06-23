import type * as React from "react";

import { cn } from "../../lib/utils";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn("rounded-xl border border-line bg-white p-4", className)}
      {...props}
    />
  );
}
