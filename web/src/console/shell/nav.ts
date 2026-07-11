import type { IconKey } from "./icons";

/**
 * Console navigation registry + persona deny-by-omission filter.
 *
 * The console owns its own nav model (the legacy `components/shell/nav.ts` is
 * banned by the purity guard and encodes the legacy AppShell's different group
 * structure). The group/label/icon structure here is carbon-copied from the
 * prototype's `navGroups` (`Oyatie Console.dc.html`): 개요 · 인사 · 급여·근태 ·
 * ERP · 현장 운영 · 거버넌스 · 분석 · 자동화 · 커뮤니케이션.
 *
 * Visibility is **deny-by-omission**: an item that declares a `gate` is hidden
 * unless the caller's grants intersect it. Ungated items (personal + comms —
 * every persona has an inbox and messaging) stay visible to any authenticated
 * session. Role/feature codes mirror the backend `Role` enum and permission
 * matrix (`backend/crates/platform/authz`); the backend re-authorizes every
 * call, so this only shapes what the nav offers.
 */

export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  EXECUTIVE: "EXECUTIVE",
  MECHANIC: "MECHANIC",
  RECEPTIONIST: "RECEPTIONIST",
  MEMBER: "MEMBER",
} as const;

/** Backend feature-grant codes this nav gates on (subset of the full matrix). */
export const FEATURES = {
  WORK_ORDER_READ_ALL: "work_order_read_all",
  WORK_ORDER_CREATE: "work_order_create",
  COMPLETION_REVIEW: "completion_review",
  KPI_READ: "kpi_read",
  EXCEL_DOWNLOAD: "excel_download",
  EMPLOYEE_DIRECTORY_READ: "employee_directory_read",
  AUDIT_LOG_READ: "audit_log_read",
  INTEGRITY_FINDINGS_READ: "integrity_findings_read",
  ROLE_MANAGE: "role_manage",
} as const;

const ADMIN_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN];
/** Management read tier (ADMIN/EXECUTIVE/SUPER_ADMIN), e.g. KPI/analytics. */
const MANAGEMENT_ROLES = [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.SUPER_ADMIN];
/** The five granted operational roles (everyone except a no-grant MEMBER). */
const OPERATIONAL_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.MECHANIC,
  ROLES.RECEPTIONIST,
];
/** RoleManage-tier surfaces are system-only (SUPER_ADMIN); never unlocked from feature grants. */
const ROLE_MANAGE_ROLES = [ROLES.SUPER_ADMIN];
/** HR directory read (ADMIN/EXECUTIVE/SUPER_ADMIN). */
const DIRECTORY_ROLES = MANAGEMENT_ROLES;
/** Integrity/compliance findings (EXECUTIVE/SUPER_ADMIN — ADMIN excluded by design). */
const INTEGRITY_ROLES = [ROLES.EXECUTIVE, ROLES.SUPER_ADMIN];

export interface NavGate {
  roles?: readonly string[];
  features?: readonly string[];
}

export interface ConsoleNavItem {
  /** `state.screen` key set on click (internal navigation, not a router path). */
  screen: string;
  labelKey: string;
  icon: IconKey;
  gate?: NavGate;
}

export interface ConsoleNavGroup {
  labelKey: string;
  labelId: string;
  items: readonly ConsoleNavItem[];
}

const g = (roles?: readonly string[], features?: readonly string[]): NavGate => ({
  roles,
  features,
});

export const NAV_GROUPS: readonly ConsoleNavGroup[] = [
  {
    labelKey: "console.shell.nav.groups.overview",
    labelId: "overview",
    items: [
      { screen: "overview", labelKey: "console.shell.nav.overview", icon: "overview" },
      { screen: "mywork", labelKey: "console.shell.nav.mywork", icon: "inbox" },
      { screen: "inbox", labelKey: "console.shell.nav.inbox", icon: "mailbox" },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.hr",
    labelId: "hr",
    items: [
      {
        screen: "hr",
        labelKey: "console.shell.nav.hr",
        icon: "users",
        gate: g(DIRECTORY_ROLES, [FEATURES.EMPLOYEE_DIRECTORY_READ]),
      },
      {
        screen: "recruit",
        labelKey: "console.shell.nav.recruit",
        icon: "userPlus",
        gate: g(DIRECTORY_ROLES, [FEATURES.EMPLOYEE_DIRECTORY_READ]),
      },
      {
        screen: "orgchart",
        labelKey: "console.shell.nav.orgchart",
        icon: "network",
        gate: g(DIRECTORY_ROLES, [FEATURES.EMPLOYEE_DIRECTORY_READ]),
      },
      {
        screen: "evaluation",
        labelKey: "console.shell.nav.evaluation",
        icon: "circleCheck",
        gate: g(DIRECTORY_ROLES, [FEATURES.EMPLOYEE_DIRECTORY_READ]),
      },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.payroll",
    labelId: "payroll",
    items: [
      {
        screen: "payroll",
        labelKey: "console.shell.nav.payroll",
        icon: "calc",
        gate: g(DIRECTORY_ROLES, [FEATURES.EMPLOYEE_DIRECTORY_READ]),
      },
      { screen: "attendance", labelKey: "console.shell.nav.attendance", icon: "clock" },
      { screen: "leave", labelKey: "console.shell.nav.leave", icon: "calCheck" },
      { screen: "benefit", labelKey: "console.shell.nav.benefit", icon: "heart" },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.erp",
    labelId: "erp",
    items: [
      { screen: "finance", labelKey: "console.shell.nav.finance", icon: "receipt", gate: g(MANAGEMENT_ROLES) },
      { screen: "purchase", labelKey: "console.shell.nav.purchase", icon: "cart", gate: g(MANAGEMENT_ROLES) },
      { screen: "inventory", labelKey: "console.shell.nav.inventory", icon: "layers", gate: g(MANAGEMENT_ROLES) },
      { screen: "asset", labelKey: "console.shell.nav.asset", icon: "box", gate: g(MANAGEMENT_ROLES) },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.fieldOps",
    labelId: "fieldOps",
    items: [
      {
        screen: "dispatch",
        labelKey: "console.shell.nav.dispatch",
        icon: "truck",
        gate: g(OPERATIONAL_ROLES, [FEATURES.WORK_ORDER_READ_ALL]),
      },
      {
        screen: "maintenance",
        labelKey: "console.shell.nav.maintenance",
        icon: "wrench",
        gate: g(OPERATIONAL_ROLES, [FEATURES.WORK_ORDER_READ_ALL]),
      },
      {
        screen: "field",
        labelKey: "console.shell.nav.field",
        icon: "mapPin",
        gate: g(OPERATIONAL_ROLES, [FEATURES.WORK_ORDER_READ_ALL]),
      },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.governance",
    labelId: "governance",
    items: [
      { screen: "appr", labelKey: "console.shell.nav.appr", icon: "checkSq" },
      { screen: "docs", labelKey: "console.shell.nav.docs", icon: "folder" },
      {
        screen: "policy",
        labelKey: "console.shell.nav.policy",
        icon: "shieldCheck",
        gate: g(ROLE_MANAGE_ROLES),
      },
      {
        screen: "compliance",
        labelKey: "console.shell.nav.compliance",
        icon: "fileCheck",
        gate: g(INTEGRITY_ROLES, [FEATURES.INTEGRITY_FINDINGS_READ]),
      },
      {
        screen: "audit",
        labelKey: "console.shell.nav.audit",
        icon: "history",
        gate: g(ADMIN_ROLES, [FEATURES.AUDIT_LOG_READ]),
      },
      { screen: "support", labelKey: "console.shell.nav.support", icon: "mailbox" },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.analytics",
    labelId: "analytics",
    items: [
      { screen: "dashboard", labelKey: "console.shell.nav.dashboard", icon: "chart", gate: g(MANAGEMENT_ROLES, [FEATURES.KPI_READ]) },
      { screen: "laborcost", labelKey: "console.shell.nav.laborcost", icon: "trend", gate: g(MANAGEMENT_ROLES, [FEATURES.KPI_READ]) },
      { screen: "objectExplorer", labelKey: "console.shell.nav.objectExplorer", icon: "share", gate: g(MANAGEMENT_ROLES) },
      // Same graph explorer + the 타입·매니저 authoring tab (draft/publish object
      // types) — gated to the authoring tier, not read access (§4-18: one
      // OntologyWorkspaceBody backs both nav slots, see screens/registry.ts).
      { screen: "ontologyManager", labelKey: "console.shell.nav.ontologyManager", icon: "share", gate: g(ROLE_MANAGE_ROLES) },
      { screen: "forecast", labelKey: "console.shell.nav.forecast", icon: "gauge", gate: g(MANAGEMENT_ROLES, [FEATURES.KPI_READ]) },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.automation",
    labelId: "automation",
    items: [
      { screen: "workflow", labelKey: "console.shell.nav.workflow", icon: "workflow", gate: g(ROLE_MANAGE_ROLES) },
      { screen: "scheduled", labelKey: "console.shell.nav.scheduled", icon: "repeat", gate: g(ROLE_MANAGE_ROLES) },
    ],
  },
  {
    labelKey: "console.shell.nav.groups.comms",
    labelId: "comms",
    items: [
      { screen: "messenger", labelKey: "console.shell.nav.messenger", icon: "msg" },
      { screen: "mail", labelKey: "console.shell.nav.mail", icon: "mail" },
      { screen: "notif", labelKey: "console.shell.nav.notif", icon: "bell" },
      { screen: "board", labelKey: "console.shell.nav.board", icon: "megaphone" },
      { screen: "directory", labelKey: "console.shell.nav.directory", icon: "book" },
    ],
  },
];

export interface ConsoleGrants {
  roles: readonly string[];
  featureGrants: readonly string[];
}

function intersects(a: readonly string[], b: readonly string[] | undefined): boolean {
  if (!b || b.length === 0) return false;
  const set = new Set(b);
  return a.some((x) => set.has(x));
}

/** Deny-by-omission: ungated → visible; gated → visible iff a role OR feature matches. */
export function isNavItemVisible(gate: NavGate | undefined, grants: ConsoleGrants): boolean {
  if (!gate) return true;
  return (
    intersects(grants.roles, gate.roles) ||
    intersects(grants.featureGrants, gate.features)
  );
}

export interface VisibleNavGroup {
  labelKey: string;
  labelId: string;
  items: ConsoleNavItem[];
}

/** The nav groups filtered to what `grants` may see; empty groups are dropped. */
export function visibleConsoleNav(grants: ConsoleGrants): VisibleNavGroup[] {
  return NAV_GROUPS.map((group) => ({
    labelKey: group.labelKey,
    labelId: group.labelId,
    items: group.items.filter((item) => isNavItemVisible(item.gate, grants)),
  })).filter((group) => group.items.length > 0);
}

/** The default screen a session lands on (first visible item, or a stable fallback). */
export function defaultScreen(grants: ConsoleGrants): string {
  return visibleConsoleNav(grants)[0]?.items[0]?.screen ?? "overview";
}
