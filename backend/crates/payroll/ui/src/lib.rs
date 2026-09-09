//! Payroll `Layer::Ui` surface. SSR HTML for `/`; no payroll math.
use leptos::prelude::*;
use serde::{Deserialize, Serialize};

const PKG_JS: &str = "/pkg/console_payroll_ui.js";
const PKG_WASM: &str = "/pkg/console_payroll_ui_bg.wasm";
/// The whole stylesheet, inlined.
///
/// It is inlined rather than served because the unauthorized shell must carry
/// no `/pkg/` reference at all -- an external stylesheet there would be a
/// request an unauthenticated visitor makes, and the test that pins the empty
/// shell forbids it. Inlining also costs the authorized screens no extra
/// round trip. No `>` in any selector: `<style>` content is emitted raw, and
/// descendant selectors keep the sheet independent of that.
const STYLE: &str = "\
:root{color-scheme:light dark;--bg:#f5f6f8;--surface:#fff;--line:#e4e7ec;--ink:#111418;\
--muted:#5c6773;--accent:#2563c7;--chip:#eef1f5;--chip-ink:#41505f;--flag:#fdeceb;--flag-ink:#9a2b25}\
@media (prefers-color-scheme:dark){:root{--bg:#0e1115;--surface:#161a20;--line:#252b33;\
--ink:#e7ebf0;--muted:#98a3af;--accent:#6ea8fe;--chip:#212831;--chip-ink:#c3ccd6;\
--flag:#3b1d1c;--flag-ink:#f0a6a1}}\
*{box-sizing:border-box}\
[hidden]{display:none!important}\
body{margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;\
font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR',sans-serif}\
a{color:inherit;text-decoration:none}\
header.app{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:22px;\
height:56px;padding:0 24px;background:var(--surface);border-bottom:1px solid var(--line)}\
.brand{font-weight:650;letter-spacing:-.01em;font-size:15px}\
header.app nav{display:flex;gap:2px}\
header.app nav a{padding:6px 12px;border-radius:8px;color:var(--muted);font-weight:550}\
header.app nav a:hover{background:var(--chip);color:var(--ink)}\
header.app nav a[aria-current]{background:var(--chip);color:var(--ink)}\
main{max-width:1020px;margin:0 auto;padding:26px 24px 72px}\
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;\
margin:0 0 20px;overflow:hidden}\
.panel h2{margin:0;padding:13px 18px;font-size:12px;font-weight:650;letter-spacing:.05em;\
text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line)}\
.toolbar{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--line)}\
.fl{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}\
select{padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);\
color:var(--ink);font:inherit;font-size:14px}\
select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}\
.row{display:flex;align-items:baseline;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line)}\
.row:last-child{border-bottom:0}\
.row:hover{background:var(--bg)}\
.row .name{font-weight:550;flex:0 0 auto}\
.row .meta{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;\
color:var(--muted);font-size:13px}\
.row .rev{flex:0 0 auto;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}\
.badge{flex:0 0 auto;margin-left:auto;padding:3px 9px;border-radius:999px;background:var(--chip);\
color:var(--chip-ink);font-size:12px;font-weight:600;letter-spacing:.02em}\
.badge[data-status*='BLOCK']{background:var(--flag);color:var(--flag-ink)}\
.state{margin:0;padding:34px 18px;text-align:center;color:var(--muted)}\
@media (max-width:640px){header.app{gap:12px;padding:0 14px}main{padding:18px 14px 56px}\
.row{flex-wrap:wrap;gap:6px 12px}.row .meta{flex:1 0 100%;order:3}}\
";

const ISLAND_BOOTSTRAP: &str = concat!(
    include_str!("island_script.js"),
    "(\"\", \"pkg\", \"console_payroll_ui\", \"console_payroll_ui_bg\");"
);

/// Contract-shaped run summary for SSR composition. Field names match
/// `PayrollRunSummary.yaml` required keys; values are already-authorized.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSummary {
    pub id: String,
    pub period_start: String,
    pub period_end: String,
    pub source_label: String,
    pub status: String,
    pub calculation_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Contract-shaped Company Head. Field names match OpenAPI `Company` required
/// keys; values are already-authorized. Same DTO as `GET /api/v1/companies`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanyView {
    pub org_id: String,
    pub legal_name: String,
    pub reg_no: String,
    pub version: String,
}

/// Contract-shaped OrgUnit Head. Field names match OpenAPI `OrgUnit` required
/// keys; values are already-authorized. Same DTO as `GET /api/v1/org-units`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgUnitView {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub version: String,
}

/// Contract-shaped Person Head. Closed four-field projection matching OpenAPI
/// `Person`; values are already-authorized. Same DTO as `GET /api/v1/persons`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonView {
    pub id: String,
    pub display_name: String,
    pub legal_name: String,
    pub version: String,
}

/// Contract-shaped Employment Head. Field names match OpenAPI `Employment`
/// required keys; values are already-authorized. Same DTO as
/// `GET /api/v1/employments`. FKs stay ids (no invented JobPosition href).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmploymentView {
    pub id: String,
    pub version: String,
    pub appointed_on: String,
    pub person_id: String,
    pub org_unit_id: String,
    pub job_position_id: String,
}

/// One shipping-screen listing after server composition.
///
/// `Omitted` is deny-by-omission (unauth / forbidden). `Empty` is an authorized
/// listing that returned zero rows. `Failure` is an authorized listing that
/// failed. Unauthorized must never become `Empty` or `Failure`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ScreenSection<T> {
    #[default]
    Omitted,
    Empty,
    Failure,
    Rows(Vec<T>),
}

impl<T> ScreenSection<T> {
    /// Map an already-authorized listing. Non-empty rows always win; empty rows
    /// are `Empty` only when the same listing floor would have allowed the GET.
    #[must_use]
    pub fn from_authorized_listing(rows: Vec<T>, listing_authorized: bool) -> Self {
        if !rows.is_empty() {
            Self::Rows(rows)
        } else if listing_authorized {
            Self::Empty
        } else {
            Self::Omitted
        }
    }

    #[must_use]
    pub const fn is_offered(&self) -> bool {
        !matches!(self, Self::Omitted)
    }
}

/// Server-composed shipping screens. `Omitted` is omit, not a client decision.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShippingScreens {
    pub companies: ScreenSection<CompanyView>,
    pub org_units: ScreenSection<OrgUnitView>,
    pub people: ScreenSection<PersonView>,
    pub employments: ScreenSection<EmploymentView>,
    pub runs: ScreenSection<RunSummary>,
}

/// Which shipping-UI body to render. Nav still only names authorized non-empty screens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiScreen {
    Home,
    Organization,
    Hr,
    Payroll,
}

/// Presentation-only revision chip. The raw value stays in `data-version`;
/// this is the label a reader sees.
fn revision_label(version: &str) -> String {
    if version.is_empty() {
        String::new()
    } else {
        format!("v{version}")
    }
}

/// Calendar day of an effective-dated value. Employment carries an RFC 3339
/// instant, but a reader of an appointment wants the day, not the zero clock
/// time. Presentation only -- `data-appointed-on` keeps the exact value.
fn day_of(value: &str) -> String {
    value
        .split_once('T')
        .map_or_else(|| value.to_owned(), |(day, _)| day.to_owned())
}

#[component]
pub fn Shell() -> impl IntoView {
    view! {
        <html lang="ko">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>"Console"</title>
                <style>{STYLE}</style>
            </head>
            <body></body>
        </html>
    }
}

/// The one hydrated subtree on this surface.
///
/// Everything else the shell renders is static SSR. This island carries the
/// only client behavior: a status filter over the runs the server already
/// authorized and serialized into `data-props`. It is presentation only --
/// it changes which authorized rows are *visible*, never which rows exist. No
/// fetch, no server function, and no business rule runs here, so
/// deny-by-omission stays a server decision and the client gains nothing it
/// was not already sent.
#[island]
pub fn AuthorizedRuns(runs: Vec<RunSummary>) -> impl IntoView {
    // Empty means "전체". The options come from the rows in hand, so the
    // control can never name a status this actor was not sent.
    let selected = RwSignal::new(String::new());
    let mut statuses: Vec<String> = runs.iter().map(|run| run.status.clone()).collect();
    statuses.sort_unstable();
    statuses.dedup();
    view! {
        <div class="toolbar">
            <label class="fl" for="run-status">"상태"</label>
            <select
                id="run-status"
                data-run-status-filter=""
                on:change:target=move |ev| selected.set(ev.target().value())
            >
                <option value="">"전체"</option>
                {statuses
                    .into_iter()
                    .map(|status| {
                        let label = status.clone();
                        view! { <option value=status>{label}</option> }
                    })
                    .collect_view()}
            </select>
        </div>
        {runs
            .into_iter()
            .map(|run| {
                let href = format!("/api/v1/payroll/runs/{}", run.id);
                let period = format!("{}–{}", run.period_start, run.period_end);
                let source = run.source_label.clone();
                let badge = run.status.clone();
                let badge_key = run.status.clone();
                // Visibility only. SSR selects nothing, so every authorized row
                // is served unhidden and a client that never hydrates still
                // sees the whole authorized listing.
                let status = run.status.clone();
                let filtered_out = move || {
                    let selected = selected.get();
                    !selected.is_empty() && selected != status
                };
                view! {
                    <a class="row" href=href hidden=filtered_out>
                        <span
                            class="name"
                            data-run-id=run.id
                            data-period-start=run.period_start
                            data-period-end=run.period_end
                            data-source-label=run.source_label
                            data-status=run.status
                            data-calculation-enabled=run.calculation_enabled.to_string()
                            data-created-at=run.created_at
                            data-updated-at=run.updated_at
                        >
                            {period}
                        </span>
                        <span class="meta">{source}</span>
                        <span class="badge" data-status=badge_key>{badge}</span>
                    </a>
                }
            })
            .collect_view()}
    }
}

#[component]
fn Companies(companies: Vec<CompanyView>) -> impl IntoView {
    companies
        .into_iter()
        .map(|company| {
            let href = format!("/api/v1/companies/{}", company.org_id);
            let label = if company.legal_name.is_empty() {
                company.org_id.clone()
            } else {
                company.legal_name.clone()
            };
            let meta = company.reg_no.clone();
            let version = revision_label(&company.version);
            view! {
                <a class="row" href=href>
                    <span
                        class="name"
                        data-org-id=company.org_id
                        data-legal-name=company.legal_name
                        data-reg-no=company.reg_no
                        data-version=company.version
                    >
                        {label}
                    </span>
                    <span class="meta">{meta}</span>
                    <span class="rev">{version}</span>
                </a>
            }
        })
        .collect_view()
}

#[component]
fn OrgUnits(units: Vec<OrgUnitView>) -> impl IntoView {
    units
        .into_iter()
        .map(|unit| {
            let href = format!("/api/v1/org-units/{}", unit.id);
            let label = if unit.name.is_empty() {
                unit.id.clone()
            } else {
                unit.name.clone()
            };
            let meta = unit.parent_id.clone();
            let version = revision_label(&unit.version);
            view! {
                <a class="row" href=href>
                    <span
                        class="name"
                        data-org-unit-id=unit.id
                        data-name=unit.name
                        data-parent-id=unit.parent_id
                        data-version=unit.version
                    >
                        {label}
                    </span>
                    <span class="meta">{meta}</span>
                    <span class="rev">{version}</span>
                </a>
            }
        })
        .collect_view()
}

#[component]
fn DirectoryPeople(people: Vec<PersonView>) -> impl IntoView {
    people
        .into_iter()
        .map(|person| {
            let href = format!("/api/v1/persons/{}", person.id);
            let label = if !person.display_name.is_empty() {
                person.display_name.clone()
            } else if !person.legal_name.is_empty() {
                person.legal_name.clone()
            } else {
                person.id.clone()
            };
            // Repeating the display name as its own subtitle is noise.
            let meta = if person.legal_name == label {
                String::new()
            } else {
                person.legal_name.clone()
            };
            let version = revision_label(&person.version);
            view! {
                <a class="row" href=href>
                    <span
                        class="name"
                        data-person-id=person.id
                        data-display-name=person.display_name
                        data-legal-name=person.legal_name
                        data-version=person.version
                    >
                        {label}
                    </span>
                    <span class="meta">{meta}</span>
                    <span class="rev">{version}</span>
                </a>
            }
        })
        .collect_view()
}

#[component]
fn Employments(employments: Vec<EmploymentView>) -> impl IntoView {
    employments
        .into_iter()
        .map(|employment| {
            let href = format!("/api/v1/employments/{}", employment.id);
            let label = if employment.appointed_on.is_empty() {
                employment.id.clone()
            } else {
                day_of(&employment.appointed_on)
            };
            let meta = employment.person_id.clone();
            let version = revision_label(&employment.version);
            view! {
                <a class="row" href=href>
                    <span
                        class="name"
                        data-employment-id=employment.id
                        data-version=employment.version
                        data-appointed-on=employment.appointed_on
                        data-person-id=employment.person_id
                        data-org-unit-id=employment.org_unit_id
                        data-job-position-id=employment.job_position_id
                    >
                        {label}
                    </span>
                    <span class="meta">{meta}</span>
                    <span class="rev">{version}</span>
                </a>
            }
        })
        .collect_view()
}

#[component]
fn ShippingNav(has_org: bool, has_hr: bool, has_payroll: bool, focus: UiScreen) -> impl IntoView {
    view! {
        <header class="app">
            <a class="brand" href="/">"Console"</a>
            <nav>
                {has_org
                    .then(|| {
                        let current = matches!(focus, UiScreen::Organization).then_some("page");
                        view! { <a href="/organization" aria-current=current>"조직"</a> }
                    })}
                {has_hr
                    .then(|| {
                        let current = matches!(focus, UiScreen::Hr).then_some("page");
                        view! { <a href="/hr" aria-current=current>"인사"</a> }
                    })}
                {has_payroll
                    .then(|| {
                        let current = matches!(focus, UiScreen::Payroll).then_some("page");
                        view! { <a href="/payroll" aria-current=current>"급여"</a> }
                    })}
            </nav>
        </header>
    }
}

#[component]
pub fn AuthorizedShell(runs: Vec<RunSummary>) -> impl IntoView {
    let nav_payroll = !runs.is_empty();
    view! {
        <ShippingShell
            companies=ScreenSection::Omitted
            org_units=ScreenSection::Omitted
            people=ScreenSection::Omitted
            employments=ScreenSection::Omitted
            runs=ScreenSection::from_authorized_listing(runs, false)
            nav_org=false
            nav_hr=false
            nav_payroll=nav_payroll
            focus=UiScreen::Home
        />
    }
}

fn org_body(
    companies: ScreenSection<CompanyView>,
    org_units: ScreenSection<OrgUnitView>,
) -> impl IntoView {
    if matches!(
        (&companies, &org_units),
        (ScreenSection::Omitted, ScreenSection::Omitted)
    ) {
        return ().into_any();
    }
    let failed = matches!(&companies, ScreenSection::Failure)
        || matches!(&org_units, ScreenSection::Failure);
    let company_rows = match companies {
        ScreenSection::Rows(rows) => rows,
        _ => Vec::new(),
    };
    let unit_rows = match org_units {
        ScreenSection::Rows(rows) => rows,
        _ => Vec::new(),
    };
    if company_rows.is_empty() && unit_rows.is_empty() {
        if failed {
            return view! {
                <section class="panel" data-screen="organization" data-state="failure">
                    <h2>"조직"</h2>
                    <p class="state">"목록을 불러오지 못했습니다"</p>
                </section>
            }
            .into_any();
        }
        return view! {
            <section class="panel" data-screen="organization" data-state="empty">
                <h2>"조직"</h2>
                <p class="state">"표시할 조직이 없습니다"</p>
            </section>
        }
        .into_any();
    }
    view! {
        <section class="panel" data-screen="organization">
            <h2>"조직"</h2>
            <Companies companies=company_rows />
            <OrgUnits units=unit_rows />
        </section>
    }
    .into_any()
}

fn hr_body(
    people: ScreenSection<PersonView>,
    employments: ScreenSection<EmploymentView>,
) -> impl IntoView {
    if matches!(
        (&people, &employments),
        (ScreenSection::Omitted, ScreenSection::Omitted)
    ) {
        return ().into_any();
    }
    let failed =
        matches!(&people, ScreenSection::Failure) || matches!(&employments, ScreenSection::Failure);
    let person_rows = match people {
        ScreenSection::Rows(rows) => rows,
        _ => Vec::new(),
    };
    let employment_rows = match employments {
        ScreenSection::Rows(rows) => rows,
        _ => Vec::new(),
    };
    if person_rows.is_empty() && employment_rows.is_empty() {
        if failed {
            return view! {
                <section class="panel" data-screen="hr" data-state="failure">
                    <h2>"인사"</h2>
                    <p class="state">"목록을 불러오지 못했습니다"</p>
                </section>
            }
            .into_any();
        }
        return view! {
            <section class="panel" data-screen="hr" data-state="empty">
                <h2>"인사"</h2>
                <p class="state">"표시할 사람이 없습니다"</p>
            </section>
        }
        .into_any();
    }
    view! {
        <section class="panel" data-screen="hr">
            <h2>"인사"</h2>
            <DirectoryPeople people=person_rows />
            <Employments employments=employment_rows />
        </section>
    }
    .into_any()
}

fn payroll_body(runs: ScreenSection<RunSummary>) -> impl IntoView {
    match runs {
        ScreenSection::Omitted => ().into_any(),
        ScreenSection::Empty => view! {
            <section class="panel" data-screen="payroll" data-state="empty">
                <h2>"급여"</h2>
                <p class="state">"표시할 급여 이력이 없습니다"</p>
            </section>
        }
        .into_any(),
        ScreenSection::Failure => view! {
            <section class="panel" data-screen="payroll" data-state="failure">
                <h2>"급여"</h2>
                <p class="state">"목록을 불러오지 못했습니다"</p>
            </section>
        }
        .into_any(),
        ScreenSection::Rows(runs) => view! {
            <section class="panel" data-screen="payroll">
                <h2>"급여"</h2>
                <AuthorizedRuns runs=runs />
            </section>
        }
        .into_any(),
    }
}

#[component]
fn ShippingShell(
    companies: ScreenSection<CompanyView>,
    org_units: ScreenSection<OrgUnitView>,
    people: ScreenSection<PersonView>,
    employments: ScreenSection<EmploymentView>,
    runs: ScreenSection<RunSummary>,
    nav_org: bool,
    nav_hr: bool,
    nav_payroll: bool,
    focus: UiScreen,
) -> impl IntoView {
    let hydrate_payroll = matches!(&runs, ScreenSection::Rows(rows) if !rows.is_empty());
    view! {
        <html lang="ko">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>"Console"</title>
                <style>{STYLE}</style>
                {hydrate_payroll
                    .then(|| {
                        view! {
                            <link rel="modulepreload" href=PKG_JS />
                            // `crossorigin` is not decoration. Without it the
                            // preload's credentials mode does not match the
                            // module's own fetch, so the browser discards the
                            // preload and the client downloads the whole
                            // bundle twice.
                            <link
                                rel="preload"
                                href=PKG_WASM
                                r#as="fetch"
                                r#type="application/wasm"
                                crossorigin="anonymous"
                            />
                            <script type="module">{ISLAND_BOOTSTRAP}</script>
                        }
                    })}
            </head>
            <body>
                <ShippingNav
                    has_org=nav_org
                    has_hr=nav_hr
                    has_payroll=nav_payroll
                    focus=focus
                />
                <main>
                    {org_body(companies, org_units)}
                    {hr_body(people, employments)}
                    {payroll_body(runs)}
                </main>
            </body>
        </html>
    }
}

pub fn render_shell() -> String {
    let mut html = String::from("<!DOCTYPE html>");
    html.push_str(&Shell().to_html());
    html
}

pub fn render_shell_with(runs: &[RunSummary]) -> String {
    render_screens(
        &ShippingScreens {
            runs: ScreenSection::from_authorized_listing(runs.to_vec(), false),
            ..ShippingScreens::default()
        },
        UiScreen::Home,
    )
}

/// SSR compose org / HR / payroll. `Omitted` is deny-by-omission.
/// Nav names every offered screen; the body is the focused route.
pub fn render_screens(screens: &ShippingScreens, focus: UiScreen) -> String {
    let nav_org = screens.companies.is_offered() || screens.org_units.is_offered();
    let nav_hr = screens.people.is_offered() || screens.employments.is_offered();
    let nav_payroll = screens.runs.is_offered();
    let companies = match focus {
        UiScreen::Home | UiScreen::Organization => screens.companies.clone(),
        UiScreen::Hr | UiScreen::Payroll => ScreenSection::Omitted,
    };
    let org_units = match focus {
        UiScreen::Home | UiScreen::Organization => screens.org_units.clone(),
        UiScreen::Hr | UiScreen::Payroll => ScreenSection::Omitted,
    };
    let people = match focus {
        UiScreen::Home | UiScreen::Hr => screens.people.clone(),
        UiScreen::Organization | UiScreen::Payroll => ScreenSection::Omitted,
    };
    let employments = match focus {
        UiScreen::Home | UiScreen::Hr => screens.employments.clone(),
        UiScreen::Organization | UiScreen::Payroll => ScreenSection::Omitted,
    };
    let runs = match focus {
        UiScreen::Home | UiScreen::Payroll => screens.runs.clone(),
        UiScreen::Organization | UiScreen::Hr => ScreenSection::Omitted,
    };
    let focus_denied = match focus {
        UiScreen::Home => !nav_org && !nav_hr && !nav_payroll,
        UiScreen::Organization => !nav_org,
        UiScreen::Hr => !nav_hr,
        UiScreen::Payroll => !nav_payroll,
    };
    if focus_denied {
        return render_shell();
    }
    let mut html = String::from("<!DOCTYPE html>");
    html.push_str(
        &view! {
            <ShippingShell
                companies=companies
                org_units=org_units
                people=people
                employments=employments
                runs=runs
                nav_org=nav_org
                nav_hr=nav_hr
                nav_payroll=nav_payroll
                focus=focus
            />
        }
        .to_html(),
    );
    html
}

#[cfg(feature = "ssr")]
mod ssr {
    use super::{
        RunSummary, ShippingScreens, UiScreen, render_screens, render_shell, render_shell_with,
    };
    use axum::Router;
    use axum::http::header;
    use axum::response::{Html, IntoResponse};
    use axum::routing::get;

    pub fn html_shell() -> Html<String> {
        Html(render_shell())
    }

    pub fn html_shell_with(runs: &[RunSummary]) -> Html<String> {
        Html(render_shell_with(runs))
    }

    pub fn html_shell_with_screens(screens: &ShippingScreens, focus: UiScreen) -> Html<String> {
        Html(render_screens(screens, focus))
    }

    pub fn payroll_ui_js() -> &'static [u8] {
        include_bytes!("../pkg/console_payroll_ui.js")
    }

    pub fn payroll_ui_wasm() -> &'static [u8] {
        include_bytes!("../pkg/console_payroll_ui_bg.wasm")
    }

    async fn pkg_js() -> impl IntoResponse {
        (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            payroll_ui_js(),
        )
    }

    async fn pkg_wasm() -> impl IntoResponse {
        (
            [(header::CONTENT_TYPE, "application/wasm")],
            payroll_ui_wasm(),
        )
    }

    pub fn pkg_router<S>() -> Router<S>
    where
        S: Clone + Send + Sync + 'static,
    {
        Router::new()
            .route("/pkg/console_payroll_ui.js", get(pkg_js))
            .route("/pkg/console_payroll_ui_bg.wasm", get(pkg_wasm))
    }
}

#[cfg(feature = "ssr")]
pub use ssr::{
    html_shell, html_shell_with, html_shell_with_screens, payroll_ui_js, payroll_ui_wasm,
    pkg_router,
};

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    leptos::mount::hydrate_islands();
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const PAYROLL_RUN_SUMMARY_SCHEMA: &str =
        include_str!("../../rest/openapi/schemas/PayrollRunSummary.yaml");
    const OPENAPI: &str = include_str!("../../../../openapi/openapi.yaml");

    fn sample_run() -> RunSummary {
        RunSummary {
            id: "00000000-0000-0000-0000-000000000001".to_owned(),
            period_start: "2026-06-01".to_owned(),
            period_end: "2026-06-30".to_owned(),
            source_label: "workflow_runtime_m2:run:example".to_owned(),
            status: "BLOCKED_LEGAL_GATE".to_owned(),
            calculation_enabled: false,
            created_at: "2026-06-01T00:00:00Z".to_owned(),
            updated_at: "2026-06-01T00:00:00Z".to_owned(),
        }
    }

    fn yaml_required_keys(schema: &str) -> Vec<&str> {
        let mut keys = Vec::new();
        let mut in_required = false;
        for line in schema.lines() {
            let trimmed = line.trim();
            if trimmed == "required:" {
                in_required = true;
                continue;
            }
            if in_required {
                if let Some(key) = trimmed.strip_prefix("- ") {
                    keys.push(key);
                } else if trimmed.ends_with(':') {
                    break;
                }
            }
        }
        keys
    }

    fn yaml_schema_required_keys<'a>(doc: &'a str, schema: &str) -> Vec<&'a str> {
        let header = format!("    {schema}:\n");
        let rest = doc
            .split_once(&header)
            .unwrap_or_else(|| panic!("OpenAPI must declare schema {schema}"))
            .1;
        yaml_required_keys(rest)
    }

    #[test]
    fn empty_runs_match_unauthenticated_shell() {
        assert_eq!(render_shell_with(&[]), render_shell());
        assert!(
            !render_shell().contains("data-run-id"),
            "empty shell must omit run markup: {}",
            render_shell()
        );
        assert!(
            !render_shell().contains("/pkg/"),
            "empty shell must not load WASM: {}",
            render_shell()
        );
    }

    #[test]
    fn authorized_runs_carry_contract_keys_and_omit_won() {
        let html = render_shell_with(&[sample_run()]);
        let lowered = html.to_ascii_lowercase();
        assert!(
            html.contains("data-run-id=\"00000000-0000-0000-0000-000000000001\""),
            "{html}"
        );
        for key in yaml_required_keys(PAYROLL_RUN_SUMMARY_SCHEMA) {
            let attr = if key == "id" {
                "data-run-id".to_owned()
            } else {
                format!("data-{}", key.replace('_', "-"))
            };
            assert!(
                html.contains(&attr),
                "authorized markup must carry contract key {key} as {attr}: {html}"
            );
        }
        assert!(!lowered.contains("won"), "won leaked: {html}");
        assert!(!html.contains("291_520"), "golden won leaked: {html}");
        assert!(!lowered.contains("payslip"), "payslip leaked: {html}");
        assert!(
            html.contains("rel=\"modulepreload\"") && html.contains(PKG_JS),
            "authorized markup must preload bindgen js: {html}"
        );
        assert!(
            html.contains(PKG_WASM),
            "authorized markup must preload wasm: {html}"
        );
        assert!(
            html.contains("(\"\", \"pkg\", \"console_payroll_ui\", \"console_payroll_ui_bg\")"),
            "authorized markup must invoke leptos island_script: {html}"
        );
        assert!(
            html.contains("href=\"/api/v1/payroll/runs/00000000-0000-0000-0000-000000000001\""),
            "payroll drill-through must use the existing run GET: {html}"
        );
        // Anchored on `>text<` so this proves the value is rendered content,
        // not merely a data-* attribute. Stronger than matching a concatenated
        // string, and independent of how the row lays the two values out.
        assert!(
            html.contains(">2026-06-01–2026-06-30<")
                && html.contains(">workflow_runtime_m2:run:example<"),
            "payroll drill-through must show human-safe period and source_label: {html}"
        );
        assert!(
            !html.contains("/api/v1/employees/") && !html.contains("/api/v1/users/"),
            "must not drill through privileged employee/user GET: {html}"
        );
        let component = island_component(&html).unwrap_or("");
        assert!(
            component.starts_with("AuthorizedRuns_"),
            "island data-component must be the wasm-bindgen export: {html}"
        );
        let js = std::str::from_utf8(payroll_ui_js()).unwrap_or("");
        assert!(
            js.contains(&format!("export function {component}")),
            "committed bindgen js must export {component}"
        );
        assert_eq!(
            &payroll_ui_wasm()[..4],
            b"\0asm",
            "committed wasm must be a Wasm module"
        );
        // Close the binding: SSR -> JS -> wasm. Without this a fresh bindgen JS
        // paired with a stale wasm passes, because the JS carries the export
        // name and the wasm was only checked for its magic bytes.
        let needle = component.as_bytes();
        assert!(
            payroll_ui_wasm().windows(needle.len()).any(|w| w == needle),
            "committed wasm must contain the {component} export the SSR page names"
        );
        assert!(
            !render_shell().contains("AuthorizedRuns"),
            "empty shell must not emit an island: {}",
            render_shell()
        );
    }

    /// The island must own a presentation-only status filter.
    ///
    /// This is the only client behavior on the surface, and it is what makes
    /// selective hydration observable: without it the island re-renders markup
    /// identical to SSR and a broken bundle is indistinguishable from a working
    /// one. The filter changes visibility of rows the server already
    /// authorized; it never adds, removes, or requests a row, so deny-by-
    /// omission stays a server decision.
    #[test]
    fn authorized_runs_island_owns_a_presentation_only_status_filter() {
        let runs = vec![
            run_with("00000000-0000-0000-0000-000000000001", "DRAFT"),
            run_with("00000000-0000-0000-0000-000000000002", "BLOCKED_LEGAL_GATE"),
            run_with("00000000-0000-0000-0000-000000000003", "DRAFT"),
        ];
        let html = render_shell_with(&runs);
        let island = island_subtree(&html).unwrap_or("");
        assert!(
            !island.is_empty(),
            "authorized runs must be an island: {html}"
        );

        // Inside the island subtree, so hydration owns the control. A filter
        // rendered in the static shell would never receive an event listener.
        assert!(
            island.contains("data-run-status-filter"),
            "island must carry the status filter: {island}"
        );

        // Options are exactly the distinct statuses of the authorized rows plus
        // the all-option: no fixed enum, no status this actor was not sent.
        assert!(
            island.contains(r#"<option value="">"#),
            "filter must offer an all-option: {island}"
        );
        for status in ["DRAFT", "BLOCKED_LEGAL_GATE"] {
            assert!(
                island.contains(&format!(r#"<option value="{status}">"#)),
                "filter must offer authorized status {status}: {island}"
            );
        }
        assert_eq!(
            island.matches("<option").count(),
            3,
            "filter must offer the all-option and each distinct status once: {island}"
        );
        assert!(
            !island.contains("PAYABLE") && !island.contains("APPROVED"),
            "filter must not invent a status the actor was not sent: {island}"
        );

        // Every authorized row is served, none pre-hidden. Filtering is client
        // visibility over server-composed membership.
        assert_eq!(
            island.matches("data-run-id=").count(),
            3,
            "server must send every authorized row unfiltered: {island}"
        );
        // Scoped to each anchor's open tag: that keeps the serialized
        // `data-props` out of range -- a run whose `source_label` merely
        // contained the word must not fail this -- while keeping the form
        // Leptos actually emits in range. It renders a boolean attribute bare
        // (` hidden`, never ` hidden="..."`) and puts `class` last, so matching
        // on ` hidden=` or ` hidden>` would be a check that cannot fail.
        // Counted first so the loop cannot pass vacuously. The row count
        // asserted above does not imply an anchor exists -- rewriting the row
        // element would keep `data-run-id` at three and silently zero this.
        let anchors: Vec<&str> = island.split("<a ").skip(1).collect();
        assert_eq!(
            anchors.len(),
            3,
            "every authorized row must be an anchor: {island}"
        );
        for tag in anchors {
            let open = tag.split_once('>').map_or(tag, |(open, _)| open);
            assert!(
                !open.contains(" hidden"),
                "SSR must not pre-hide an authorized row: {island}"
            );
        }
        // The filter's only effect. `.row` sets `display:flex` and both
        // selectors have specificity (0,1,0), so without `!important` the
        // later rule wins on source order and the `hidden` attribute is inert:
        // the island hydrates, the control responds, and nothing disappears.
        // No Rust test can observe that symptom, so pin the rule itself.
        assert!(
            STYLE.contains("[hidden]{display:none!important}"),
            "the status filter works by toggling `hidden`; this rule is what makes it visible"
        );

        // The unauthorized shell gains nothing.
        assert!(
            !render_shell().contains("data-run-status-filter"),
            "empty shell must not carry the filter: {}",
            render_shell()
        );
    }

    fn run_with(id: &str, status: &str) -> RunSummary {
        RunSummary {
            id: id.to_owned(),
            status: status.to_owned(),
            ..sample_run()
        }
    }

    /// The `<leptos-island>` subtree only. Everything else on the page is static
    /// shell that never hydrates.
    fn island_subtree(html: &str) -> Option<&str> {
        let (_, rest) = html.split_once("<leptos-island ")?;
        rest.split_once("</leptos-island>").map(|(inner, _)| inner)
    }

    fn island_component(html: &str) -> Option<&str> {
        html.split_once("data-component=\"")
            .and_then(|(_, rest)| rest.split_once('"').map(|(id, _)| id))
    }

    fn data_attr(key: &str, id_alias: &str) -> String {
        if key == "id" {
            return format!("data-{id_alias}");
        }
        let mut out = String::from("data-");
        for (i, ch) in key.chars().enumerate() {
            if ch == '_' {
                out.push('-');
            } else if ch.is_ascii_uppercase() {
                if i > 0 {
                    out.push('-');
                }
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push(ch);
            }
        }
        out
    }

    fn sample_company() -> CompanyView {
        CompanyView {
            org_id: "00000000-0000-0000-0000-0000000000aa".to_owned(),
            legal_name: "KNL".to_owned(),
            reg_no: "110111-0000000".to_owned(),
            version: "1".to_owned(),
        }
    }

    fn sample_org_unit() -> OrgUnitView {
        OrgUnitView {
            id: "00000000-0000-0000-0000-0000000000dd".to_owned(),
            name: "본사".to_owned(),
            parent_id: String::new(),
            version: "1".to_owned(),
        }
    }

    fn sample_person() -> PersonView {
        PersonView {
            id: "00000000-0000-0000-0000-0000000000bb".to_owned(),
            display_name: "홍길동".to_owned(),
            legal_name: "홍길동".to_owned(),
            version: "1".to_owned(),
        }
    }

    fn sample_employment() -> EmploymentView {
        EmploymentView {
            id: "00000000-0000-0000-0000-0000000000ee".to_owned(),
            version: "1".to_owned(),
            appointed_on: "2026-01-15T00:00:00Z".to_owned(),
            person_id: "00000000-0000-0000-0000-0000000000bb".to_owned(),
            org_unit_id: "00000000-0000-0000-0000-0000000000dd".to_owned(),
            job_position_id: String::new(),
        }
    }

    fn assert_not_directory_person(html: &str) {
        assert!(
            !html.contains("data-employee-")
                && !html.contains("data-slug")
                && !html.contains("data-account-status")
                && !html.contains("data-has-passkey")
                && !html.contains("data-branch-ids")
                && !html.contains("data-is-active")
                && !html.contains("employee_identity"),
            "Person Head must stay the closed four-field projection: {html}"
        );
    }

    fn assert_shipping_invariants(html: &str) {
        let lowered = html.to_ascii_lowercase();
        assert!(!lowered.contains("won"), "won leaked: {html}");
        assert!(!html.contains("291_520"), "golden won leaked: {html}");
        assert!(!lowered.contains("payslip"), "payslip leaked: {html}");
        assert!(
            !lowered.contains("group-switcher") && !lowered.contains("data-group-switch"),
            "Group switcher is not admitted unless it only displays authorized scope: {html}"
        );
        assert!(
            !lowered.contains("comms-rail") && !html.contains("data-comms"),
            "comms rail is out of this slice: {html}"
        );
        assert!(
            !html.contains("type=\"file\"")
                && !lowered.contains("import/export")
                && !html.contains("자료실"),
            "import/export is not the data-entry base: {html}"
        );
        assert!(
            !html.contains("webpack") && !html.contains("vite") && !html.contains("innerHTML"),
            "must stay Rust-native Leptos SSR, not a JS wrapper: {html}"
        );
        assert!(
            !html.contains("/api/v1/job-positions/"),
            "must not invent JobPosition routes: {html}"
        );
        assert!(
            !html.contains("type=\"date\"")
                && !html.contains("name=\"as_of\"")
                && !html.contains("name=\"from\"")
                && !html.contains("name=\"to\""),
            "current-slice directory must not invent a temporal picker: {html}"
        );
    }

    #[test]
    fn shipping_screens_empty_matches_unauthenticated_shell() {
        let empty = ShippingScreens::default();
        assert_eq!(render_screens(&empty, UiScreen::Home), render_shell());
        assert_eq!(
            render_screens(&empty, UiScreen::Organization),
            render_shell()
        );
        assert_eq!(render_screens(&empty, UiScreen::Hr), render_shell());
        assert_eq!(render_screens(&empty, UiScreen::Payroll), render_shell());
        assert!(
            !render_shell().contains("data-screen="),
            "empty shell must omit screen markup: {}",
            render_shell()
        );
        assert!(
            !render_shell().contains("href=\"/"),
            "empty shell must omit nav: {}",
            render_shell()
        );
        assert_shipping_invariants(&render_shell());

        let authorized_empty = ShippingScreens {
            companies: ScreenSection::Empty,
            org_units: ScreenSection::Empty,
            people: ScreenSection::Empty,
            employments: ScreenSection::Empty,
            runs: ScreenSection::Empty,
        };
        let empty_org = render_screens(&authorized_empty, UiScreen::Organization);
        assert_ne!(
            empty_org,
            render_shell(),
            "authorized-empty org must not reuse the silent deny shell"
        );
        assert!(
            empty_org.contains("data-screen=\"organization\"")
                && empty_org.contains("data-state=\"empty\"")
                && empty_org.contains("표시할 조직이 없습니다"),
            "authorized-empty org must mount Korean empty copy: {empty_org}"
        );
        assert!(
            !empty_org.contains("data-org-id"),
            "authorized-empty must not leak rows: {empty_org}"
        );
        assert_shipping_invariants(&empty_org);

        let empty_pay = render_screens(&authorized_empty, UiScreen::Payroll);
        assert_ne!(empty_pay, render_shell(), "{empty_pay}");
        assert!(
            empty_pay.contains("data-screen=\"payroll\"")
                && empty_pay.contains("data-state=\"empty\"")
                && empty_pay.contains("표시할 급여 이력이 없습니다")
                && !empty_pay.contains("/pkg/")
                && !empty_pay.contains("data-run-id"),
            "authorized-empty payroll is SSR empty copy, not omit and not WASM: {empty_pay}"
        );
        assert_eq!(
            render_screens(&ShippingScreens::default(), UiScreen::Payroll),
            render_shell(),
            "unauthorized payroll must stay deny-by-omission"
        );

        let failed = ShippingScreens {
            companies: ScreenSection::Failure,
            org_units: ScreenSection::Omitted,
            people: ScreenSection::Omitted,
            employments: ScreenSection::Omitted,
            runs: ScreenSection::Failure,
        };
        let fail_html = render_screens(&failed, UiScreen::Payroll);
        assert!(
            fail_html.contains("data-screen=\"payroll\"")
                && fail_html.contains("data-state=\"failure\"")
                && fail_html.contains("목록을 불러오지 못했습니다")
                && !fail_html.contains("data-run-id")
                && !fail_html.contains("/pkg/"),
            "listing failure marks the section without object ids: {fail_html}"
        );
        assert_shipping_invariants(&fail_html);
    }

    #[test]
    fn shipping_screens_organization_is_ssr_contracts_and_omits_wasm() {
        let screens = ShippingScreens {
            companies: ScreenSection::Rows(vec![sample_company()]),
            org_units: ScreenSection::Rows(vec![sample_org_unit()]),
            ..ShippingScreens::default()
        };
        let html = render_screens(&screens, UiScreen::Organization);
        assert_ne!(html, render_shell(), "{html}");
        assert!(
            html.contains("data-screen=\"organization\""),
            "organization body must be a mounted SSR screen: {html}"
        );
        for key in yaml_schema_required_keys(OPENAPI, "Company") {
            let attr = data_attr(key, "org-id");
            assert!(
                html.contains(&attr),
                "org markup must carry Company Head key {key} as {attr}: {html}"
            );
        }
        for key in yaml_schema_required_keys(OPENAPI, "OrgUnit") {
            let attr = data_attr(key, "org-unit-id");
            assert!(
                html.contains(&attr),
                "org markup must carry OrgUnit Head key {key} as {attr}: {html}"
            );
        }
        assert!(
            html.contains("data-org-id=\"00000000-0000-0000-0000-0000000000aa\""),
            "{html}"
        );
        assert!(
            html.contains("data-org-unit-id=\"00000000-0000-0000-0000-0000000000dd\""),
            "{html}"
        );
        assert!(
            html.contains("KNL") && html.contains("본사"),
            "org row must show human-safe Company legal_name and OrgUnit name: {html}"
        );
        assert!(
            html.contains("href=\"/api/v1/companies/00000000-0000-0000-0000-0000000000aa\"")
                && html.contains("href=\"/api/v1/org-units/00000000-0000-0000-0000-0000000000dd\""),
            "org must drill through published Company/OrgUnit instance GETs: {html}"
        );
        assert!(
            !html.contains("/api/v1/org-entities/")
                && !html.contains("/api/v1/employees/")
                && !html.contains("/api/v1/users/"),
            "must not invent privileged hrefs: {html}"
        );
        assert!(
            !html.contains("data-slug") && !html.contains("data-status="),
            "must not keep the OrgEntitySummary dual contract: {html}"
        );
        assert!(
            html.contains("href=\"/organization\""),
            "authorized org nav is SSR: {html}"
        );
        assert!(
            !html.contains("href=\"/hr\"") && !html.contains("href=\"/payroll\""),
            "nav must omit unauthorized/empty screens: {html}"
        );
        assert!(
            !html.contains("/pkg/"),
            "org read projection is SSR, not an island: {html}"
        );
        assert!(
            island_component(&html).is_none(),
            "org screen must not emit an island: {html}"
        );
        assert_shipping_invariants(&html);
    }

    #[test]
    fn shipping_screens_hr_is_ssr_contracts_and_omits_phone() {
        let screens = ShippingScreens {
            people: ScreenSection::Rows(vec![sample_person()]),
            employments: ScreenSection::Rows(vec![sample_employment()]),
            ..ShippingScreens::default()
        };
        let html = render_screens(&screens, UiScreen::Hr);
        assert_ne!(html, render_shell(), "{html}");
        assert!(
            html.contains("data-screen=\"hr\""),
            "HR body must be a mounted SSR screen: {html}"
        );
        for key in yaml_schema_required_keys(OPENAPI, "Person") {
            let attr = data_attr(key, "person-id");
            assert!(
                html.contains(&attr),
                "HR markup must carry Person Head key {key} as {attr}: {html}"
            );
        }
        assert_eq!(
            yaml_schema_required_keys(OPENAPI, "Person"),
            ["id", "version", "display_name", "legal_name"],
            "Person Head must stay the published four-field set"
        );
        for key in yaml_schema_required_keys(OPENAPI, "Employment") {
            let attr = data_attr(key, "employment-id");
            assert!(
                html.contains(&attr),
                "HR markup must carry Employment Head key {key} as {attr}: {html}"
            );
        }
        assert_eq!(
            yaml_schema_required_keys(OPENAPI, "Employment"),
            [
                "id",
                "version",
                "appointed_on",
                "person_id",
                "org_unit_id",
                "job_position_id"
            ],
            "Employment Head must stay the published six-field set"
        );
        assert!(
            html.contains("data-person-id=\"00000000-0000-0000-0000-0000000000bb\""),
            "{html}"
        );
        assert!(
            html.contains("data-employment-id=\"00000000-0000-0000-0000-0000000000ee\""),
            "{html}"
        );
        assert!(
            html.contains("홍길동"),
            "HR row must show human-safe display_name: {html}"
        );
        assert!(
            html.contains("href=\"/api/v1/persons/00000000-0000-0000-0000-0000000000bb\""),
            "HR must drill through the published Person instance GET: {html}"
        );
        assert!(
            html.contains("href=\"/api/v1/employments/00000000-0000-0000-0000-0000000000ee\""),
            "HR must drill through the published Employment instance GET: {html}"
        );
        assert!(
            html.contains("data-job-position-id=\"\""),
            "job_position_id stays an id attribute, including empty: {html}"
        );
        assert!(
            !html.contains("/api/v1/employees/") && !html.contains("/api/v1/users/"),
            "HR must not drill through privileged employee/user GET: {html}"
        );
        assert_not_directory_person(&html);
        assert!(
            html.contains("href=\"/hr\""),
            "authorized HR nav is SSR: {html}"
        );
        let lowered = html.to_ascii_lowercase();
        assert!(!lowered.contains("phone"), "directory phone leaked: {html}");
        assert!(
            !lowered.contains("salary")
                && !lowered.contains("bank_account")
                && !lowered.contains("base_pay")
                && !html.contains("data-rrn"),
            "Employment Head must not copy write-bag or PII: {html}"
        );
        assert!(
            !html.contains("/pkg/"),
            "HR read projection is SSR, not an island: {html}"
        );
        assert!(
            island_component(&html).is_none(),
            "HR screen must not emit an island: {html}"
        );
        assert_shipping_invariants(&html);
    }

    #[test]
    fn shipping_screens_home_composes_authorized_sections_only() {
        let screens = ShippingScreens {
            companies: ScreenSection::Rows(vec![sample_company()]),
            org_units: ScreenSection::Rows(vec![sample_org_unit()]),
            people: ScreenSection::Rows(vec![sample_person()]),
            employments: ScreenSection::Rows(vec![sample_employment()]),
            runs: ScreenSection::Rows(vec![sample_run()]),
        };
        let html = render_screens(&screens, UiScreen::Home);
        assert!(html.contains("data-screen=\"organization\""), "{html}");
        assert!(html.contains("data-screen=\"hr\""), "{html}");
        assert!(html.contains("data-screen=\"payroll\""), "{html}");
        assert!(html.contains("href=\"/organization\""), "{html}");
        assert!(html.contains("href=\"/hr\""), "{html}");
        assert!(html.contains("href=\"/payroll\""), "{html}");
        assert!(
            html.contains("data-org-id=\"00000000-0000-0000-0000-0000000000aa\"")
                && html.contains("data-org-unit-id=\"00000000-0000-0000-0000-0000000000dd\"")
                && html.contains("data-legal-name=")
                && html.contains("data-person-id=\"00000000-0000-0000-0000-0000000000bb\"")
                && html.contains("data-employment-id=\"00000000-0000-0000-0000-0000000000ee\"")
                && html.contains("data-run-id=\"00000000-0000-0000-0000-000000000001\""),
            "home must carry published Head identifiers: {html}"
        );
        assert_not_directory_person(&html);
        let component = island_component(&html).unwrap_or("");
        assert!(
            component.starts_with("AuthorizedRuns_"),
            "payroll interaction stays the AuthorizedRuns island: {html}"
        );
        assert!(
            html.contains("/pkg/console_payroll_ui.js"),
            "WASM hydrate only when the payroll island is composed: {html}"
        );
        assert_shipping_invariants(&html);

        let payroll_only = render_screens(
            &ShippingScreens {
                runs: ScreenSection::Rows(vec![sample_run()]),
                ..ShippingScreens::default()
            },
            UiScreen::Payroll,
        );
        assert!(
            payroll_only.contains("data-screen=\"payroll\""),
            "{payroll_only}"
        );
        assert!(
            !payroll_only.contains("data-screen=\"organization\"")
                && !payroll_only.contains("data-screen=\"hr\""),
            "focused payroll must omit other bodies: {payroll_only}"
        );
        assert_shipping_invariants(&payroll_only);
    }

    #[test]
    fn shipping_screens_focus_keeps_authorized_nav_and_omits_wasm_off_payroll() {
        let screens = ShippingScreens {
            companies: ScreenSection::Rows(vec![sample_company()]),
            org_units: ScreenSection::Rows(vec![sample_org_unit()]),
            people: ScreenSection::Rows(vec![sample_person()]),
            employments: ScreenSection::Rows(vec![sample_employment()]),
            runs: ScreenSection::Rows(vec![sample_run()]),
        };

        let org_html = render_screens(&screens, UiScreen::Organization);
        assert!(
            org_html.contains("data-screen=\"organization\""),
            "{org_html}"
        );
        assert!(
            !org_html.contains("data-screen=\"hr\"")
                && !org_html.contains("data-screen=\"payroll\""),
            "focused org must omit other bodies: {org_html}"
        );
        assert!(org_html.contains("href=\"/organization\""), "{org_html}");
        assert!(org_html.contains("href=\"/hr\""), "{org_html}");
        assert!(org_html.contains("href=\"/payroll\""), "{org_html}");
        assert!(
            !org_html.contains("/pkg/"),
            "org body must not hydrate WASM: {org_html}"
        );
        assert_shipping_invariants(&org_html);

        let payroll_html = render_screens(&screens, UiScreen::Payroll);
        assert!(
            payroll_html.contains("data-screen=\"payroll\""),
            "{payroll_html}"
        );
        assert!(
            !payroll_html.contains("data-screen=\"organization\"")
                && !payroll_html.contains("data-screen=\"hr\""),
            "focused payroll must omit other bodies: {payroll_html}"
        );
        assert!(
            payroll_html.contains("href=\"/organization\"")
                && payroll_html.contains("href=\"/hr\"")
                && payroll_html.contains("href=\"/payroll\""),
            "authorized nav must stay reachable from a focused screen: {payroll_html}"
        );
        assert!(
            payroll_html.contains("/pkg/console_payroll_ui.js"),
            "{payroll_html}"
        );
        assert_shipping_invariants(&payroll_html);

        let denied_payroll = render_screens(
            &ShippingScreens {
                companies: ScreenSection::Rows(vec![sample_company()]),
                ..ShippingScreens::default()
            },
            UiScreen::Payroll,
        );
        assert_eq!(
            denied_payroll,
            render_shell(),
            "unauthorized payroll route must omit, not leak sibling nav"
        );
    }
}
