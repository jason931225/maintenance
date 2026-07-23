import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";

import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";

type Employee = {
  id: string;
  name: string;
  employee_number?: string | null;
  company: string;
  org_unit?: string | null;
  position?: string | null;
  worksite_name?: string | null;
  home_branch_name?: string | null;
};
type Branch = { id: string; name: string };
type EmploymentType = "REGULAR" | "CONTRACT" | "PART_TIME" | "INTERN";
type Form = Record<"employee_number" | "name" | "company" | "phone" | "org_unit" | "position" | "site" | "home_branch_id" | "base_pay", string> & { employment_type: EmploymentType };
type EmployeeDetail = { employee: Employee; employment: { employment_type: EmploymentType; phone_e164: string; base_pay: string; currency: "KRW" } };

const initialForm: Form = { employee_number: "", name: "", company: "", employment_type: "REGULAR", phone: "", org_unit: "", position: "", site: "", home_branch_id: "", base_pay: "" };
const shell: CSSProperties = { height: "100%", overflow: "auto", padding: "var(--sp-6)", display: "grid", gap: "var(--sp-6)", background: "var(--canvas)" };
const panel: CSSProperties = { display: "grid", gap: "var(--sp-4)", padding: "var(--sp-6)", border: "var(--border-hairline)", borderRadius: "var(--radius-card)", background: "var(--surface)" };
const fields: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))", gap: "var(--sp-4)" };
const apiScopeIds = new WeakMap<object, number>();
let nextApiScopeId = 0;

function peopleScope(api: object, authorityKey: string): string {
  let apiScopeId = apiScopeIds.get(api);
  if (apiScopeId === undefined) {
    apiScopeId = ++nextApiScopeId;
    apiScopeIds.set(api, apiScopeId);
  }
  return `${authorityKey}:${String(apiScopeId)}`;
}

function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
}

/** Accept Korean local, international, or punctuation-delimited input and submit
 * the stable E.164 value required by the HR contract. The server normalizes and
 * validates again; this only prevents an avoidable retry round trip. */
function normalizePhoneInput(value: string): string {
  const compact = value.trim().replace(/[^+\d]/g, "");
  if (!compact) return "";
  if (compact.startsWith("+82")) return `+82${compact.slice(3).replace(/^0/, "")}`;
  if (compact.startsWith("82")) return `+82${compact.slice(2).replace(/^0/, "")}`;
  if (compact.startsWith("0")) return `+82${compact.slice(1)}`;
  return compact.startsWith("+") ? compact : `+${compact}`;
}

function formatKrwInput(value: string): string {
  const numeric = value.replaceAll(",", "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{0,2})?$/.test(numeric)) return value;
  const [whole, ...fraction] = numeric.split(".");
  const formattedWhole = whole ? Number(whole).toLocaleString("ko-KR") : "";
  return fraction.length ? `${formattedWhole}.${fraction.join("")}` : formattedWhole;
}

function canonicalPay(value: string): string | undefined {
  const numeric = value.replaceAll(",", "");
  return /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(numeric) ? numeric : undefined;
}

function displayPay(value: string, currency: string): string {
  const number = Number(value);
  return `${Number.isFinite(number) ? number.toLocaleString("ko-KR") : value} ${currency}`;
}

function directEntrySuggestions(employees: readonly Employee[], key: "company" | "org_unit" | "position" | "worksite_name"): string[] {
  return Array.from(new Set(employees.map((employee) => employee[key]).filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b, "ko"));
}

/** Real People & Workforce create/read surface. Directory cards intentionally
 * use the ordinary list contract; compensation is only read from the privileged
 * detail response and is never fabricated in client state. */
export function PeopleWorkforceBody() {
  const { api, session } = useAuth();
  const authorityKey = [session?.org_id, session?.user_id, session?.access_token, session?.client_session_incarnation].join(":");
  return <PeopleWorkforceSession key={peopleScope(api, authorityKey)} api={api} />;
}

type PeopleWorkforceApi = ReturnType<typeof useAuth>["api"];

function PeopleWorkforceSession({ api }: { api: PeopleWorkforceApi }) {
  const copy = ko.console.people;
  const employmentTypeLabel = (type: EmploymentType): string => copy.employmentTypes[type];
  const [form, setForm] = useState<Form>(initialForm);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [detail, setDetail] = useState<EmployeeDetail>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [openingDetail, setOpeningDetail] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const idempotencyKey = useRef(crypto.randomUUID());
  const authorityEpoch = useRef(0);
  const directoryEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++directoryEpoch.current;
    setLoading(true); setError(undefined); setDenied(false);
    try {
      const [directory, branchResult] = await Promise.all([
        api.GET("/api/v1/employees", { params: { query: { limit: 25, offset: 0, search: query || undefined } } }),
        api.GET("/api/v1/branches"),
      ]);
      if (epoch !== directoryEpoch.current) return;
      if (directory.response.status === 403 || branchResult.response.status === 403) { setDenied(true); setEmployees([]); setBranches([]); }
      else if (!directory.data || !branchResult.data) setError(errorText(directory.error ?? branchResult.error, copy.loadError));
      else { setEmployees(directory.data.items); setBranches(branchResult.data); }
    } catch (loadError) {
      if (epoch !== directoryEpoch.current) return;
      setError(errorText(loadError, copy.loadError));
    } finally {
      if (epoch === directoryEpoch.current) setLoading(false);
    }
  }, [api, copy.loadError, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [load]);

  useEffect(() => () => {
    authorityEpoch.current += 1;
    directoryEpoch.current += 1;
    detailEpoch.current += 1;
  }, []);
  const update = (key: keyof Form, value: string): void => { setForm((current) => ({ ...current, [key]: value })); };
  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const basePay = canonicalPay(form.base_pay);
    if (!basePay) { setError(copy.invalidBasePay); return; }
    const epoch = authorityEpoch.current;
    setSubmitting(true); setError(undefined); setNotice(undefined);
    const body = { ...form, phone: normalizePhoneInput(form.phone), base_pay: basePay, idempotency_key: idempotencyKey.current };
    try {
      const response = await api.POST("/api/v1/employees", { body });
      if (epoch !== authorityEpoch.current) return;
      if (!response.data) { setError(errorText(response.error, copy.createError)); return; }
      setDetail(response.data);
      setNotice(copy.saved(response.data.employee.name));
      setForm(initialForm);
      idempotencyKey.current = crypto.randomUUID();
      await load();
    } catch (submitError) {
      if (epoch === authorityEpoch.current) setError(errorText(submitError, copy.createError));
    } finally {
      if (epoch === authorityEpoch.current) setSubmitting(false);
    }
  };
  const openDetail = async (employee: Employee) => {
    const epoch = ++detailEpoch.current;
    setDetail(undefined); setOpeningDetail(true); setError(undefined); setNotice(undefined);
    try {
      const response = await api.GET("/api/v1/employees/{id}", { params: { path: { id: employee.id } } });
      if (epoch !== detailEpoch.current) return;
      if (!response.data) { setError(errorText(response.error, copy.detailError)); return; }
      setDetail(response.data);
    } catch (detailError) {
      if (epoch !== detailEpoch.current) return;
      setError(errorText(detailError, copy.detailError));
    } finally {
      if (epoch === detailEpoch.current) setOpeningDetail(false);
    }
  };
  const suggestions = useMemo(() => ({
    company: directEntrySuggestions(employees, "company"),
    org_unit: directEntrySuggestions(employees, "org_unit"),
    position: directEntrySuggestions(employees, "position"),
    site: directEntrySuggestions(employees, "worksite_name"),
  }), [employees]);

  return <main aria-labelledby="people-title" style={shell}>
    <header><h1 id="people-title">{copy.title}</h1></header>
    {denied ? <section style={panel} role="alert"><strong>{copy.accessDenied}</strong><span>{copy.accessDeniedDescription}</span></section> : null}
    {error ? <section style={panel} role="alert"><strong>{error}</strong><button type="button" onClick={() => void load()}>{copy.retry}</button></section> : null}
    <section style={panel} aria-busy={submitting}>
      <h2>{copy.createTitle}</h2>{notice ? <p role="status">{notice}</p> : null}
      <form onSubmit={(event) => { void submit(event); }} style={fields}>
        {([ ["employee_number", copy.fields.employee_number], ["name", copy.fields.name], ["company", copy.fields.company], ["phone", copy.fields.phone], ["org_unit", copy.fields.org_unit], ["position", copy.fields.position], ["site", copy.fields.site], ["base_pay", copy.fields.base_pay] ] as const).map(([key, label]) => <label key={key}>{label}<input required value={form[key]} list={["company", "org_unit", "position", "site"].includes(key) ? `employee-${key}-options` : undefined} inputMode={key === "base_pay" ? "decimal" : key === "phone" ? "tel" : undefined} onBlur={(event) => { if (key === "phone") update(key, normalizePhoneInput(event.target.value)); if (key === "base_pay") update(key, formatKrwInput(event.target.value)); }} onChange={(event) => { update(key, key === "base_pay" ? formatKrwInput(event.target.value) : event.target.value); }} /></label>)}
        {Object.entries(suggestions).map(([key, values]) => <datalist key={key} id={`employee-${key}-options`}>{values.map((value) => <option key={value} value={value} />)}</datalist>)}
        <label>{copy.fields.employmentType}<select value={form.employment_type} onChange={(event) => { update("employment_type", event.target.value); }}><option value="REGULAR">{copy.employmentTypes.REGULAR}</option><option value="CONTRACT">{copy.employmentTypes.CONTRACT}</option><option value="PART_TIME">{copy.employmentTypes.PART_TIME}</option><option value="INTERN">{copy.employmentTypes.INTERN}</option></select></label>
        <label>{copy.fields.homeBranch}<select required value={form.home_branch_id} onChange={(event) => { update("home_branch_id", event.target.value); }}><option value="">{copy.activeBranchPlaceholder}</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <div><button type="submit" disabled={submitting || denied}>{submitting ? copy.submitting : copy.submit}</button></div>
      </form>
    </section>
    {detail ? <section style={panel} aria-busy={openingDetail} aria-labelledby="employee-detail-title"><h2 id="employee-detail-title">{copy.detailTitle}</h2><dl><dt>{copy.detail.name}</dt><dd>{detail.employee.name}</dd><dt>{copy.detail.employmentType}</dt><dd>{employmentTypeLabel(detail.employment.employment_type)}</dd><dt>{copy.detail.phone}</dt><dd>{detail.employment.phone_e164}</dd><dt>{copy.detail.basePay}</dt><dd>{displayPay(detail.employment.base_pay, detail.employment.currency)}</dd><dt>{copy.detail.homeBranch}</dt><dd>{detail.employee.home_branch_name ?? copy.detail.unset}</dd></dl></section> : null}
    <section style={panel} aria-busy={loading}><h2>{copy.directoryTitle}</h2><label>{copy.fields.search}<input value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder={copy.searchPlaceholder} /></label>
      {loading ? <p>{copy.loading}</p> : employees.length === 0 ? <p>{copy.empty}</p> : <ul>{employees.map((employee) => <li key={employee.id}><button type="button" onClick={() => void openDetail(employee)} disabled={openingDetail}><strong>{employee.name}</strong> {employee.employee_number ? `(${employee.employee_number})` : ""}</button><br /><small>{[employee.company, employee.org_unit, employee.position, employee.worksite_name, employee.home_branch_name].filter(Boolean).join(copy.separator)}</small></li>)}</ul>}
    </section>
  </main>;
}
