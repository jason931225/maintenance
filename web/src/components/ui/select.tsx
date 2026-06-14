import type * as React from "react";

import { cn } from "../../lib/utils";

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "min-h-12 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-950 outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-300 aria-invalid:border-red-500",
        className,
      )}
      {...props}
    />
  );
}
