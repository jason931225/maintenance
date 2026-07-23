import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";

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

const initialForm: Form = { employee_number: "", name: "", company: "", employment_type: "REGULAR", phone: "", org_unit: "", position: "", site: "", home_branch_id: "", base_pay: "" };
const shell: CSSProperties = { height: "100%", overflow: "auto", padding: "var(--sp-6)", display: "grid", gap: "var(--sp-6)", background: "var(--canvas)" };
const panel: CSSProperties = { display: "grid", gap: "var(--sp-4)", padding: "var(--sp-6)", border: "var(--border-hairline)", borderRadius: "var(--radius-card)", background: "var(--surface)" };
const fields: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))", gap: "var(--sp-4)" };

function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
}

/** Real People & Workforce create/read surface. Directory cards intentionally
 * use the ordinary list contract; compensation is only fetched after the
 * privileged create/detail response and is never fabricated in the UI. */
export function PeopleWorkforceBody() {
  const { api } = useAuth();
  const [form, setForm] = useState<Form>(initialForm);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true); setError(undefined); setDenied(false);
    const [directory, branchResult] = await Promise.all([
      api.GET("/api/v1/employees", { params: { query: { limit: 25, offset: 0, search: query || undefined } } }),
      api.GET("/api/v1/branches"),
    ]);
    if (directory.response.status === 403 || branchResult.response.status === 403) { setDenied(true); setEmployees([]); setBranches([]); }
    else if (!directory.data || !branchResult.data) setError(errorText(directory.error ?? branchResult.error, "People data could not be loaded."));
    else { setEmployees(directory.data.items as Employee[]); setBranches(branchResult.data as Branch[]); }
    setLoading(false);
  }, [api, query]);

  useEffect(() => { void load(); }, [load]);
  const update = (key: keyof Form, value: string) => setForm((current) => ({ ...current, [key]: value } as Form));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(undefined); setNotice(undefined);
    const idempotency_key = crypto.randomUUID();
    const response = await api.POST("/api/v1/employees", { body: { ...form, idempotency_key } });
    if (!response.data) { setError(errorText(response.error, "Employee could not be created. Your entries were kept for retry.")); setSubmitting(false); return; }
    setNotice(`${response.data.employee.name} was saved. Compensation is available only in privileged detail.`);
    setForm(initialForm); setSubmitting(false); await load();
  };

  return <main aria-labelledby="people-title" style={shell}>
    <header><h1 id="people-title">People &amp; Workforce</h1><p>Tenant-scoped personnel directory and governed employment records.</p></header>
    {denied ? <section style={panel} role="alert"><strong>Access denied</strong><span>You do not have HR directory authority. No directory records were loaded.</span></section> : null}
    {error ? <section style={panel} role="alert"><strong>{error}</strong><button type="button" onClick={() => void load()}>Retry</button></section> : null}
    <section style={panel} aria-busy={submitting}>
      <h2>Create employee</h2>{notice ? <p role="status">{notice}</p> : null}
      <form onSubmit={submit} style={fields}>
        {([ ["employee_number", "Employee number"], ["name", "Name"], ["company", "Company"], ["phone", "Phone"], ["org_unit", "Org unit"], ["position", "Position"], ["site", "Site"], ["base_pay", "Base pay (KRW)"] ] as const).map(([key, label]) => <label key={key}>{label}<input required value={form[key]} inputMode={key === "base_pay" ? "decimal" : undefined} onChange={(e) => update(key, e.target.value)} /></label>)}
        <label>Employment type<select value={form.employment_type} onChange={(e) => update("employment_type", e.target.value)}><option value="REGULAR">Regular</option><option value="CONTRACT">Contract</option><option value="PART_TIME">Part time</option><option value="INTERN">Intern</option></select></label>
        <label>Home branch<select required value={form.home_branch_id} onChange={(e) => update("home_branch_id", e.target.value)}><option value="">Choose an active branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <div><button type="submit" disabled={submitting || denied}>{submitting ? "Saving…" : "Create employee"}</button></div>
      </form>
    </section>
    <section style={panel} aria-busy={loading}><h2>Directory</h2><label>Search people<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or employee number" /></label>
      {loading ? <p>Loading directory…</p> : employees.length === 0 ? <p>No employees match this search.</p> : <ul>{employees.map((employee) => <li key={employee.id}><strong>{employee.name}</strong> {employee.employee_number ? `(${employee.employee_number})` : ""}<br /><small>{[employee.company, employee.org_unit, employee.position, employee.worksite_name, employee.home_branch_name].filter(Boolean).join(" · ")}</small></li>)}</ul>}
    </section>
  </main>;
}
