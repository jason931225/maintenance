import { PageHeader } from "../components/shell/PageHeader";
import { Card } from "../components/ui/card";
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
        <ReportingCommandCenter />
        <ReportingExport />
      </div>
    </>
  );
}

function ReportingCommandCenter() {
  const links = [
    { label: ko.reporting.command.links.kpi, href: "/kpi" },
    { label: ko.reporting.command.links.ops, href: "/ops" },
    { label: ko.reporting.command.links.wallboard, href: "/wallboard" },
    { label: ko.reporting.command.links.support, href: "/support" },
  ];

  return (
    <Card className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-steel">
            {ko.reporting.command.eyebrow}
          </p>
          <h2 className="text-lg font-semibold text-ink">
            {ko.reporting.command.title}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <a
              key={link.href}
              className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-muted-panel"
              href={link.href}
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {ko.reporting.command.controls.map((control) => (
          <div
            key={control.label}
            className="rounded-md border border-line bg-muted-panel p-3"
          >
            <p className="text-xs font-semibold text-steel">{control.label}</p>
            <p className="mt-1 text-sm font-medium text-ink">{control.value}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
