import { ko } from "../../i18n/ko";

interface PageEmptyProps {
  message?: string;
}

/** Shared empty state. */
export function PageEmpty({ message }: PageEmptyProps) {
  return (
    <p className="rounded-md border border-dashed border-line p-6 text-center text-sm text-steel">
      {message ?? ko.page.empty}
    </p>
  );
}
