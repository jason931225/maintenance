import { Upload } from "lucide-react";
import { useRef, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type { RegistryImportReport } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";

interface EquipmentImportPanelProps {
  api: ConsoleApiClient;
  /** Re-runs the page search so a fresh import is reflected in the list. */
  onImported: () => void;
}

type UploadState = "idle" | "uploading" | "error";

/**
 * Admin-gated (MasterListImport) .xlsx upload that POSTs the forklift master-list
 * workbook to /api/v1/equipment/import as multipart/form-data and renders the
 * per-row created/updated/error summary. The backend re-checks authorization.
 */
export function EquipmentImportPanel({
  api,
  onImported,
}: EquipmentImportPanelProps) {
  const t = ko.equipment.import;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [state, setState] = useState<UploadState>("idle");
  const [report, setReport] = useState<RegistryImportReport>();
  const [notice, setNotice] = useState<string>();

  async function handleUpload() {
    if (!file) {
      setState("error");
      return;
    }
    setState("uploading");
    setNotice(undefined);
    setReport(undefined);
    try {
      const response = await api.POST("/api/v1/equipment/import", {
        // openapi-fetch sends the schema body verbatim; build the multipart
        // FormData ourselves and let the browser set the boundary header.
        body: { file: file as unknown as string },
        bodySerializer(body: { file: string }) {
          const form = new FormData();
          form.append("file", body.file as unknown as File);
          return form;
        },
      });
      if (!response.data) {
        throw new Error("equipment import response missing data");
      }
      setReport(response.data);
      setNotice(t.done);
      setState("idle");
      setFile(undefined);
      if (inputRef.current) inputRef.current.value = "";
      onImported();
    } catch {
      setState("error");
    }
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>

      {notice ? (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {notice}
        </p>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {file ? t.failed : t.noFile}
        </p>
      ) : null}

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="equipment-import-file"
        >
          {t.fileLabel}
        </label>
        <input
          ref={inputRef}
          id="equipment-import-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label={t.fileLabel}
          className="text-sm text-steel"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0]);
            setState("idle");
          }}
        />
      </div>

      <div className="flex items-center justify-end">
        <Button
          type="button"
          disabled={!file || state === "uploading"}
          onClick={() => {
            void handleUpload();
          }}
        >
          <Upload aria-hidden="true" size={16} />
          {state === "uploading" ? t.uploading : t.submit}
        </Button>
      </div>

      {report ? (
        <dl className="grid gap-2 rounded-md border border-line bg-muted-panel p-3 text-sm sm:grid-cols-3">
          <ReportRow label={t.inputRows} value={report.input_rows} />
          <ReportRow label={t.equipmentCount} value={report.equipment_count} />
          <ReportRow label={t.added} value={report.added} />
          <ReportRow label={t.updated} value={report.updated} />
          <ReportRow label={t.unchanged} value={report.unchanged} />
          <ReportRow label={t.orphaned} value={report.orphaned} />
          <ReportRow label={t.errors} value={report.errors.length} />
        </dl>
      ) : null}
    </Card>
  );
}

function ReportRow({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="font-semibold text-steel">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
