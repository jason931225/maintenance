import { ko } from "../../i18n/ko";

/** Shared loading state. Renders a polite status region for SR users. */
export function PageSpinner() {
  return (
    <div className="flex h-40 items-center justify-center" role="status">
      <span className="text-sm font-medium text-slate-600">
        {ko.page.loading}
      </span>
    </div>
  );
}
