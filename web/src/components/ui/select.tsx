import type * as React from "react";

import { cn } from "../../lib/utils";

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "min-h-12 w-full rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-red-500",
        className,
      )}
      {...props}
    />
  );
}
