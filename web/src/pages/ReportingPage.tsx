import { PageHeader } from "../components/shell/PageHeader";
import { ReportingExport } from "../features/reporting/ReportingExport";
import { ko } from "../i18n/ko";

export function ReportingPage() {
  return (
    <>
      <PageHeader
        title={ko.reporting.title}
        description={ko.reporting.description}
      />
      <div className="grid gap-5">
        <ReportingExport />
      </div>
    </>
  );
}
