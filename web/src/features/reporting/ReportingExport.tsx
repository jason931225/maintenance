import { useState } from "react";
import { Download } from "lucide-react";

import { useAuth } from "../../context/auth";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { PageError } from "../../components/states/PageError";
import { ko } from "../../i18n/ko";
import { todayInSeoul } from "../../lib/utils";

/** The reporting export endpoints, keyed by the report the user selects. */
const REPORT_PATHS = {
  "work-diary": "/api/v1/exports/work-diary",
  "daily-status": "/api/v1/exports/daily-status",
} as const;

type ReportKind = keyof typeof REPORT_PATHS;

const REPORT_LABELS: Record<ReportKind, string> = {
  "work-diary": ko.reporting.reports.workDiary,
  "daily-status": ko.reporting.reports.dailyStatus,
};

/** Today's date in YYYY-MM-DD (Korea Standard Time), the default report date. */
function todayIso(): string {
  return todayInSeoul();
}

/**
 * Pull the attachment filename out of a Content-Disposition header, falling back
 * to a deterministic `<report>-<date>.xlsx` name when the header is absent (e.g.
 * a CORS-stripped response). Handles the `filename="..."` form the backend emits.
 */
function filenameFromDisposition(
  disposition: string | null,
  fallback: string,
): string {
  if (disposition) {
    const match = /filename\*?=(?:UTF-8'')?"?([^"]+)"?/i.exec(disposition);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return fallback;
}

/** Trigger a browser download for a generated workbook blob. */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type DownloadState = "idle" | "loading" | "error";

/**
 * Reporting export panel: pick a report (work-diary / daily-status) and a date, then
 * download the generated Excel workbook. The backend serves a binary xlsx
 * response (Feature::ExcelDownload, allowed for every role), so the response is
 * read as a blob and saved via an object URL.
 */
export function ReportingExport() {
  const { api } = useAuth();
  const [report, setReport] = useState<ReportKind>("work-diary");
  const [date, setDate] = useState(todayIso);
  const [state, setState] = useState<DownloadState>("idle");
  const [doneLabel, setDoneLabel] = useState<string | undefined>(undefined);

  async function download(): Promise<void> {
    setState("loading");
    setDoneLabel(undefined);
    try {
      const response = await api.GET(REPORT_PATHS[report], {
        params: { query: { date } },
        parseAs: "blob",
      });
      const blob = response.data;
      if (!response.response.ok || !blob) {
        setState("error");
        return;
      }
      const fallback = `${report}-${date}.xlsx`;
      const fileName = filenameFromDisposition(
        response.response.headers.get("content-disposition"),
        fallback,
      );
      saveBlob(blob, fileName);
      setDoneLabel(REPORT_LABELS[report]);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <Card className="grid max-w-xl gap-4">
      {state === "error" ? (
        <PageError message={ko.reporting.downloadFailed} />
      ) : null}
      <div className="grid gap-2">
        <label
          htmlFor="reporting-report"
          className="text-sm font-semibold text-slate-800"
        >
          {ko.reporting.reportLabel}
        </label>
        <Select
          id="reporting-report"
          value={report}
          onChange={(event) => {
            setReport(event.target.value as ReportKind);
          }}
        >
          <option value="work-diary">{REPORT_LABELS["work-diary"]}</option>
          <option value="daily-status">{REPORT_LABELS["daily-status"]}</option>
        </Select>
      </div>
      <div className="grid gap-2">
        <label
          htmlFor="reporting-date"
          className="text-sm font-semibold text-slate-800"
        >
          {ko.reporting.dateLabel}
        </label>
        <Input
          id="reporting-date"
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
          }}
        />
      </div>
      <Button
        type="button"
        onClick={() => {
          void download();
        }}
        disabled={state === "loading" || !date}
      >
        <Download aria-hidden="true" size={16} />
        {state === "loading" ? ko.reporting.downloading : ko.reporting.download}
      </Button>
      {doneLabel ? (
        <p role="status" className="text-sm font-medium text-emerald-700">
          {ko.reporting.downloadDone.replace("{report}", doneLabel)}
        </p>
      ) : null}
      <p className="text-xs text-slate-500">{ko.reporting.historyNote}</p>
    </Card>
  );
}
