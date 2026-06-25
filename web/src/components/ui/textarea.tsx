import type * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Multi-line text field.
 *
 * The default height is a modest ~3 rows (`min-h-20`). Short single-purpose
 * fields (schedule reasons, memos, chat composers) should pass `rows={2}` and,
 * where appropriate, a `min-h-*` / `resize-none` override via `className` — both
 * win over the defaults here because `cn` (tailwind-merge) keeps the last
 * conflicting utility. Pass `rows` to size the box semantically.
 */
export function Textarea({
  className,
  ref,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-20 w-full rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-red-500 aria-invalid:focus-visible:outline-red-500",
        className,
      )}
      {...props}
    />
  );
}
