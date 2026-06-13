import type { ReactNode } from "react";

import { usePageTitle } from "../../context/title";

interface PageHeaderProps {
  /** Visually-primary page heading. Rendered as the single <h1> for the page. */
  title: string;
  description?: string;
  /** Actions rendered top-right (e.g. a refresh button or a count badge). */
  actions?: ReactNode;
}

/**
 * Consistent page header used across every protected page. Owns the page's
 * single <h1> (visually primary) and mirrors the title into the Topbar's
 * contextual label via usePageTitle.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  usePageTitle(title);

  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-slate-950">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-slate-600">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
