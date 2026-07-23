import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { useAuth } from "../../context/auth";

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
  if (compact.startsWith("+82")) return compact;
  if (compact.startsWith("82")) return `+${compact}`;
  if (compact.startsWith("0")) return `+82${compact.slice(1)}`;
  return compact.startsWith("+") ? compact : `+${compact}`;
}

function formatKrwInput(value: string): string {
  const numeric = value.replace(/[^\d.]/g, "");
  const [whole, ...fraction] = numeric.split(".");
  const formattedWhole = whole ? Number(whole).toLocaleString("ko-KR") : "";
  return fraction.length ? `${formattedWhole}.${fraction.join("")}` : formattedWhole;
}

function canonicalPay(value: string): string {
  return value.replace(/,/g, "");
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
  const { api } = useAuth();
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

  const load = useCallback(async () => {
    setLoading(true); setError(undefined); setDenied(false);
    try {
      const [directory, branchResult] = await Promise.all([
        api.GET("/api/v1/employees", { params: { query: { limit: 25, offset: 0, search: query || undefined } } }),
        api.GET("/api/v1/branches"),
      ]);
      if (directory.response.status === 403 || branchResult.response.status === 403) { setDenied(true); setEmployees([]); setBranches([]); }
      else if (!directory.data || !branchResult.data) setError(errorText(directory.error ?? branchResult.error, "People data could not be loaded."));
      else { setEmployees(directory.data.items as Employee[]); setBranches(branchResult.data as Branch[]); }
    } catch (loadError) {
      setError(errorText(loadError, "People data could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [api, query]);

  useEffect(() => { void load(); }, [load]);
  const update = (key: keyof Form, value: string) => setForm((current) => ({ ...current, [key]: value } as Form));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(undefined); setNotice(undefined);
    const body = { ...form, phone: normalizePhoneInput(form.phone), base_pay: canonicalPay(form.base_pay), idempotency_key: idempotencyKey.current };
    try {
      const response = await api.POST("/api/v1/employees", { body });
      if (!response.data) { setError(errorText(response.error, "Employee could not be created. Your entries were kept for retry.")); return; }
      setDetail(response.data as EmployeeDetail);
      setNotice(`${response.data.employee.name} was saved.`);
      setForm(initialForm);
      idempotencyKey.current = crypto.randomUUID();
      await load();
    } catch (submitError) {
      setError(errorText(submitError, "Employee could not be created. Your entries were kept for retry."));
    } finally {
      setSubmitting(false);
    }
  };
  const openDetail = async (employee: Employee) => {
    setOpeningDetail(true); setError(undefined); setNotice(undefined);
    try {
      const response = await api.GET("/api/v1/employees/{id}", { params: { path: { id: employee.id } } });
      if (!response.data) { setError(errorText(response.error, "Employee detail could not be loaded.")); return; }
      setDetail(response.data as EmployeeDetail);
    } catch (detailError) {
      setError(errorText(detailError, "Employee detail could not be loaded."));
    } finally {
      setOpeningDetail(false);
    }
  };
  const suggestions = useMemo(() => ({
    company: directEntrySuggestions(employees, "company"),
    org_unit: directEntrySuggestions(employees, "org_unit"),
    position: directEntrySuggestions(employees, "position"),
    site: directEntrySuggestions(employees, "worksite_name"),
  }), [employees]);

  return <main aria-labelledby="people-title" style={shell}>
    <header><h1 id="people-title">인사 · 인력 운영</h1></header>
    {denied ? <section style={panel} role="alert"><strong>접근 권한 없음</strong><span>인사 명부를 조회하거나 변경할 권한이 없습니다.</span></section> : null}
    {error ? <section style={panel} role="alert"><strong>{error}</strong><button type="button" onClick={() => void load()}>다시 시도</button></section> : null}
    <section style={panel} aria-busy={submitting}>
      <h2>직원 등록</h2>{notice ? <p role="status">{notice}</p> : null}
      <form onSubmit={submit} style={fields}>
        {([ ["employee_number", "사번"], ["name", "성명"], ["company", "법인"], ["phone", "전화번호"], ["org_unit", "조직"], ["position", "직책"], ["site", "근무지"], ["base_pay", "기본급 (KRW)"] ] as const).map(([key, label]) => <label key={key}>{label}<input required value={form[key]} list={["company", "org_unit", "position", "site"].includes(key) ? `employee-${key}-options` : undefined} inputMode={key === "base_pay" ? "decimal" : key === "phone" ? "tel" : undefined} onBlur={(event) => { if (key === "phone") update(key, normalizePhoneInput(event.target.value)); if (key === "base_pay") update(key, formatKrwInput(event.target.value)); }} onChange={(event) => update(key, key === "base_pay" ? formatKrwInput(event.target.value) : event.target.value)} /></label>)}
        {Object.entries(suggestions).map(([key, values]) => <datalist key={key} id={`employee-${key}-options`}>{values.map((value) => <option key={value} value={value} />)}</datalist>)}
        <label>고용 형태<select value={form.employment_type} onChange={(event) => update("employment_type", event.target.value)}><option value="REGULAR">정규직</option><option value="CONTRACT">계약직</option><option value="PART_TIME">시간제</option><option value="INTERN">인턴</option></select></label>
        <label>소속 지점<select required value={form.home_branch_id} onChange={(event) => update("home_branch_id", event.target.value)}><option value="">활성 지점 선택</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <div><button type="submit" disabled={submitting || denied}>{submitting ? "저장 중…" : "직원 등록"}</button></div>
      </form>
    </section>
    {detail ? <section style={panel} aria-busy={openingDetail} aria-labelledby="employee-detail-title"><h2 id="employee-detail-title">직원 상세</h2><dl><dt>성명</dt><dd>{detail.employee.name}</dd><dt>고용 형태</dt><dd>{detail.employment.employment_type}</dd><dt>전화번호</dt><dd>{detail.employment.phone_e164}</dd><dt>기본급</dt><dd>{displayPay(detail.employment.base_pay, detail.employment.currency)}</dd><dt>소속 지점</dt><dd>{detail.employee.home_branch_name ?? "-"}</dd></dl></section> : null}
    <section style={panel} aria-busy={loading}><h2>직원 명부</h2><label>직원 검색<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="성명 또는 사번" /></label>
      {loading ? <p>명부를 불러오는 중…</p> : employees.length === 0 ? <p>검색 조건에 맞는 직원이 없습니다.</p> : <ul>{employees.map((employee) => <li key={employee.id}><button type="button" onClick={() => void openDetail(employee)} disabled={openingDetail}><strong>{employee.name}</strong> {employee.employee_number ? `(${employee.employee_number})` : ""}</button><br /><small>{[employee.company, employee.org_unit, employee.position, employee.worksite_name, employee.home_branch_name].filter(Boolean).join(" · ")}</small></li>)}</ul>}
    </section>
  </main>;
}
