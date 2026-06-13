import { ko } from "../../i18n/ko";

interface PageEmptyProps {
  message?: string;
}

/** Shared empty state. */
export function PageEmpty({ message }: PageEmptyProps) {
  return (
    <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
      {message ?? ko.page.empty}
    </p>
  );
}
