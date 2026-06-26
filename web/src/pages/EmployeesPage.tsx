import { Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConsoleApiClient } from "../api/client";
import type {
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  EmployeeImportSummary,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatListCount } from "../lib/utils";

const EMPLOYEE_IMPORT_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;

type ReadState = "loading" | "idle" | "error";
type UploadState = "idle" | "uploading" | "error";

type EmployeeApi = ConsoleApiClient & {
  GET(
    path: "/api/v1/employees",
    options?: { params?: { query?: { limit?: number; offset?: number; company?: string } } },
  ): Promise<{ data?: EmployeeDirectoryPage }>;
  POST(
    path: "/api/v1/employees/import",
    options: {
      body: { file: string };
      bodySerializer: (body: { file: string }) => FormData;
    },
  ): Promise<{ data?: EmployeeImportSummary }>;
};

export function EmployeesPage() {
  const { api, session } = useAuth();
  const employeeApi = api as EmployeeApi;
  const t = ko.employees;
  const canImport = hasAnyRole(session?.roles, EMPLOYEE_IMPORT_ROLES);

  const [state, setState] = useState<ReadState>("loading");
  const [employees, setEmployees] = useState<EmployeeDirectoryItem[]>([]);
  const [total, setTotal] = useState<number>();
  const [company, setCompany] = useState("all");

  const loadEmployees = useCallback(async () => {
    setState("loading");
    const items: EmployeeDirectoryItem[] = [];
    let nextOffset = 0;
    let discoveredTotal = 0;

    for (let page = 0; page < 10; page += 1) {
      const response = await employeeApi
        .GET("/api/v1/employees", {
          params: { query: { limit: 1000, offset: nextOffset } },
        })
        .catch(() => undefined);
      const data = response?.data;
      if (!data) {
        setState("error");
        return;
      }

      items.push(...data.items);
      discoveredTotal = data.total;
      if (items.length >= data.total || data.items.length === 0) break;
      nextOffset += data.items.length;
    }

    setEmployees(items);
    setTotal(discoveredTotal || items.length);
    setState("idle");
  }, [employeeApi]);

  useEffect(() => {
    void Promise.resolve().then(loadEmployees);
  }, [loadEmployees]);

  const companies = useMemo(
    () => Array.from(new Set(employees.map(companyName).filter(Boolean))).sort(),
    [employees],
  );
  const visibleEmployees = useMemo(
    () => employees.filter((employee) => company === "all" || companyName(employee) === company),
    [company, employees],
  );

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadEmployees();
            }}
            isLoading={state === "loading"}
          />
        }
      />

      <div className="grid max-w-6xl gap-5">
        <Card className="grid gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid min-w-56 gap-2">
              <label className="text-sm font-medium text-steel" htmlFor="employee-company-filter">
                {t.companyFilter}
              </label>
              <Select
                id="employee-company-filter"
                value={company}
                onChange={(event) => {
                  setCompany(event.currentTarget.value);
                }}
              >
                <option value="all">{t.allCompanies}</option>
                {companies.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-sm font-medium text-steel" aria-live="polite">
              {formatListCount(visibleEmployees.length)} / {formatListCount(total ?? employees.length)}
            </p>
          </div>
        </Card>

        {state === "loading" ? <SkeletonTable rows={5} cols={9} /> : null}
        {state === "error" ? (
          <PageError
            message={t.loadFailed}
            onRetry={() => {
              void loadEmployees();
            }}
          />
        ) : null}
        {state === "idle" ? <EmployeeTable employees={visibleEmployees} /> : null}

        {canImport ? (
          <EmployeeImportPanel
            api={employeeApi}
            onImported={() => {
              void loadEmployees();
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function EmployeeTable({ employees }: { employees: EmployeeDirectoryItem[] }) {
  const t = ko.employees;
  if (employees.length === 0) return <PageEmpty message={t.empty} />;

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="min-w-full divide-y divide-line text-sm">
        <thead className="bg-muted-panel/40 text-left text-xs font-semibold uppercase tracking-wide text-steel">
          <tr>
            <th className="px-4 py-3">{t.columns.name}</th>
            <th className="px-4 py-3">{t.columns.company}</th>
            <th className="px-4 py-3">{t.columns.sourceRow}</th>
            <th className="px-4 py-3">{t.columns.worksite}</th>
            <th className="px-4 py-3">{t.columns.job}</th>
            <th className="px-4 py-3">{t.columns.position}</th>
            <th className="px-4 py-3">{t.columns.hireDate}</th>
            <th className="px-4 py-3">{t.columns.exitDate}</th>
            <th className="px-4 py-3">{t.columns.status}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {employees.map((employee) => (
            <tr key={employee.id}>
              <td className="px-4 py-3 font-medium text-ink">{employeeName(employee)}</td>
              <td className="px-4 py-3 text-steel">{companyName(employee)}</td>
              <td className="px-4 py-3 text-steel">{text(employee.source_row)}</td>
              <td className="px-4 py-3 text-steel">{text(employee.worksite_name ?? employee.worksite)}</td>
              <td className="px-4 py-3 text-steel">{text(employee.job)}</td>
              <td className="px-4 py-3 text-steel">{text(employee.position)}</td>
              <td className="px-4 py-3 text-steel">{text(employee.hire_date)}</td>
              <td className="px-4 py-3 text-steel">{text(employee.exit_date)}</td>
              <td className="px-4 py-3 text-steel">{text(employee.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeImportPanel({ api, onImported }: { api: EmployeeApi; onImported: () => void }) {
  const t = ko.employees.import;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [state, setState] = useState<UploadState>("idle");
  const [summary, setSummary] = useState<EmployeeImportSummary>();

  async function upload() {
    if (!file) {
      setState("error");
      return;
    }
    setState("uploading");
    setSummary(undefined);
    const response = await api
      .POST("/api/v1/employees/import", {
        body: { file: file as unknown as string },
        bodySerializer(body: { file: string }) {
          const form = new FormData();
          form.append("file", body.file as unknown as File);
          return form;
        },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setSummary(response.data);
    setState("idle");
    setFile(undefined);
    if (inputRef.current) inputRef.current.value = "";
    onImported();
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {file ? t.failed : t.noFile}
        </p>
      ) : null}
      <div className="grid gap-2">
        <label className="text-sm font-medium text-steel" htmlFor="employee-import-file">
          {t.fileLabel}
        </label>
        <input
          ref={inputRef}
          id="employee-import-file"
          data-testid="excel-import-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="text-sm text-steel"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0]);
            setState("idle");
          }}
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={!file || state === "uploading"}
          onClick={() => {
            void upload();
          }}
        >
          <Upload aria-hidden="true" size={16} />
          {state === "uploading" ? t.uploading : t.submit}
        </Button>
      </div>
      {summary ? <ImportSummary summary={summary} /> : null}
    </Card>
  );
}

function ImportSummary({ summary }: { summary: EmployeeImportSummary }) {
  const t = ko.employees.import.summary;
  const candidates: Array<[string, number | undefined]> = [
    [t.inputRows, summary.input_rows],
    [t.inserted, summary.inserted],
    [t.updated, summary.updated],
  ];
  const rows = candidates.filter(
    (row): row is [string, number] => row[1] !== undefined,
  );

  return (
    <dl className="grid gap-2 rounded-md border border-line bg-muted-panel p-3 text-sm sm:grid-cols-5">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="font-semibold text-steel">{label}</dt>
          <dd className="text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function employeeName(employee: EmployeeDirectoryItem): string {
  return text(employee.name);
}

function companyName(employee: EmployeeDirectoryItem): string {
  return text(employee.company);
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
