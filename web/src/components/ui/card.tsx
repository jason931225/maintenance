import type * as React from "react";

import { cn } from "../../lib/utils";

export function Card({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.Ref<HTMLElement>;
}) {
  return (
    <section
      ref={ref}
      className={cn("rounded-xl border border-line bg-white p-4", className)}
      {...props}
    />
  );
}
