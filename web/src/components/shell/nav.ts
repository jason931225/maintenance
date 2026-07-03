import {
  BarChart2,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  Calculator,
  CheckSquare,
  ClipboardList,
  Inbox,
  Contact,
  Store,
  FilePlus,
  FileSpreadsheet,
  Gauge,
  LifeBuoy,
  List,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  Network,
  Receipt,
  Settings2,
  Mail,
  ShieldAlert,
  ShieldCheck,
  UserCircle,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Canonical role codes, mirroring the backend `Role` enum in
 * `backend/crates/platform/authz/src/lib.rs`. These are the exact strings
 * carried in the access-token `roles` claim, so nav gating compares against
 * them directly.
 */
export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  EXECUTIVE: "EXECUTIVE",
  PAYROLL_MANAGER: "PAYROLL_MANAGER",
  HQ_PAYROLL_MANAGER: "HQ_PAYROLL_MANAGER",
  MECHANIC: "MECHANIC",
  RECEPTIONIST: "RECEPTIONIST",
  // A just-signed-up user with no role grant yet. The backend default-denies
  // every Feature but Login for MEMBER, so the nav must default-deny too: a
  // MEMBER session sees only Profile (+ the /pending landing page).
  MEMBER: "MEMBER",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const GROUP_ROLES = {
  GROUP_ADMIN: "GROUP_ADMIN",
  GROUP_VIEWER: "GROUP_VIEWER",
  GROUP_HR: "GROUP_HR",
  GROUP_LABOR: "GROUP_LABOR",
  GROUP_FINANCE: "GROUP_FINANCE",
  GROUP_MAINTENANCE: "GROUP_MAINTENANCE",
  GROUP_PAYROLL: "GROUP_PAYROLL",
  GROUP_APPROVALS: "GROUP_APPROVALS",
} as const;

export type GroupRole = (typeof GROUP_ROLES)[keyof typeof GROUP_ROLES];

export const FEATURES = {
  WORK_ORDER_READ_ALL: "work_order_read_all",
  WORK_ORDER_CREATE: "work_order_create",
  WORK_ORDER_EDIT_INTAKE: "work_order_edit_intake",
  WORK_ORDER_START: "work_order_start",
  WORK_REPORT_SUBMIT: "work_report_submit",
  EVIDENCE_ATTACH: "evidence_attach",
  COMPLETION_REVIEW: "completion_review",
  DAILY_PLAN_REQUEST: "daily_plan_request",
  DAILY_PLAN_REVIEW: "daily_plan_review",
  TARGET_MANAGE: "target_manage",
  ORG_WIDE_QUEUE_TRIAGE: "org_wide_queue_triage",
  KPI_READ: "kpi_read",
  USER_MANAGE: "user_manage",
  ROLE_MANAGE: "role_manage",
  REGION_MANAGE: "region_manage",
  BRANCH_MANAGE: "branch_manage",
  EQUIPMENT_MANAGE: "equipment_manage",
  PURCHASE_REQUEST_READ: "purchase_request_read",
  INSPECTION_SCHEDULE_MANAGE: "inspection_schedule_manage",
  AUDIT_LOG_READ: "audit_log_read",
  EXCEL_DOWNLOAD: "excel_download",
  OPS_DASHBOARD_READ: "ops_dashboard_read",
  SALES_MANAGE: "sales_manage",
  INTEGRITY_FINDINGS_READ: "integrity_findings_read",
  INTEGRITY_FINDING_TRIAGE: "integrity_finding_triage",
  MAIL_ACCOUNT_MANAGE: "mail_account_manage",
  MAIL_USE: "mail_use",
  EMPLOYEE_DIRECTORY_READ: "employee_directory_read",
  PAYROLL_READ: "payroll_read",
  PAYROLL_MANAGE: "payroll_manage",
} as const;

export type FeatureGrant = (typeof FEATURES)[keyof typeof FEATURES];

/** True when `roles` contains at least one of `allowed`. */
export function hasAnyRole(
  roles: readonly string[] | undefined,
  allowed: readonly Role[],
): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some((role) => (allowed as readonly string[]).includes(role));
}

export function hasGroupAdminRole(
  groupRoles: readonly string[] | undefined,
): boolean {
  return groupRoles?.includes(GROUP_ROLES.GROUP_ADMIN) ?? false;
}

export function hasAnyFeatureGrant(
  featureGrants: readonly string[] | undefined,
  allowed: readonly FeatureGrant[],
): boolean {
  if (!featureGrants || featureGrants.length === 0) return false;
  return featureGrants.some((feature) =>
    (allowed as readonly string[]).includes(feature),
  );
}

/**
 * Legacy name for a session with no visible console destination beyond Profile.
 * Group-admin and mapped runtime feature grants are access grants even when the
 * built-in role claim is still the lowest-privilege MEMBER.
 */
export function isPendingMember(
  roles: readonly string[] | undefined,
  groupRoles?: readonly string[],
  featureGrants?: readonly string[],
): boolean {
  return !hasGrantedConsoleAccess(roles, groupRoles, featureGrants);
}


const ADMIN_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.SUPER_ADMIN];
const ROLE_MANAGE_ROLES: readonly Role[] = [ROLES.SUPER_ADMIN];
/**
 * The five operational tenant roles (every role except the no-grant MEMBER).
 * Used to gate the shared pages — dispatch, intake, equipment, etc. — that the
 * backend allows for any granted role but default-denies for a bare MEMBER.
 */
const OPERATIONAL_ROLES: readonly Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.MECHANIC,
  ROLES.RECEPTIONIST,
];
const LOGISTICS_MAINTENANCE_ROLES: readonly Role[] = OPERATIONAL_ROLES;
const EQUIPMENT_SALES_ROLES: readonly Role[] = OPERATIONAL_ROLES;
/**
 * Roles that can act on daily work plans. The page surfaces both the
 * DailyPlanRequest creators (MECHANIC/ADMIN/SUPER_ADMIN) and the DailyPlanReview
 * approvers (ADMIN/SUPER_ADMIN); the union is exactly the request set, so the
 * nav gate matches DailyPlanRequest. Receptionist and Executive are denied both.
 */
const DAILY_PLAN_ROLES: readonly Role[] = [
  ROLES.MECHANIC,
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
];
/** Roles allowed to read KPI dashboards (backend `KpiRead`: ADMIN/EXECUTIVE/SUPER_ADMIN). */
const KPI_ROLES: readonly Role[] = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
];
/**
 * Roles that hold EquipmentManage (backend matrix: ADMIN/EXECUTIVE/SUPER_ADMIN).
 * Mirrors the EQUIPMENT_MANAGE_ROLES constant used in the equipment pages.
 */
const EQUIPMENT_MANAGE_ROLES: readonly Role[] = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
];
/** HR employee directory read roles: ADMIN/EXECUTIVE/SUPER_ADMIN. */
const EMPLOYEE_DIRECTORY_ROLES: readonly Role[] = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
];
const PAYROLL_ROLES: readonly Role[] = [
  ROLES.PAYROLL_MANAGER,
  ROLES.HQ_PAYROLL_MANAGER,
];
/**
 * Roles that may read/triage integrity findings (backend `IntegrityFindingsRead`
 * / `IntegrityFindingTriage`, matrix row [D, D, D, D, A, A]). EXECUTIVE +
 * SUPER_ADMIN only — ADMIN is deliberately denied (labor-law sensitivity: an
 * ADMIN must not read findings about themselves). Mirrors RequireIntegrityRoute.
 */
const INTEGRITY_ROLES: readonly Role[] = [ROLES.EXECUTIVE, ROLES.SUPER_ADMIN];
/** Roles allowed to use the corporate mailbox (backend `MailUse`). */
const MAIL_USE_ROLES: readonly Role[] = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
];

/**
 * Per-item role gate. Default-deny: only `profile` is intentionally left ungated
 * (visible to any authenticated session, including a no-grant MEMBER). Every
 * other destination carries an explicit gate derived from the backend permission
 * matrix so the nav never shows a page the backend would 403, nor hides one a
 * role is entitled to:
 *  - dispatch/dispatch-map/intake/messenger/support/reporting/equipment/financial/
 *    location (WorkOrderReadAll / WorkOrderCreate / ExcelDownload / etc.): the
 *    five operational roles, NOT a bare MEMBER (which the backend default-denies).
 *  - approvals (CompletionReview): ADMIN/SUPER_ADMIN only.
 *  - kpi (KpiRead): ADMIN/EXECUTIVE/SUPER_ADMIN.
 *  - security settings (UserManage / admin OTP issuance): ADMIN/SUPER_ADMIN,
 *    matching the `RequireAdminRoute` guard on `/settings/security`.
 *  - users / org (UserManage, region/branch management): ADMIN/SUPER_ADMIN,
 *    matching the `RequireAdminRoute` guards on `/settings/users` & `/settings/org`.
 */
const ITEM_ROLE_GATES = new Map<string, readonly Role[]>([
  // Personal/department work surfaces live outside the logistics-maintenance
  // group. They remain feature/role-gated so a no-grant MEMBER is still routed
  // to /pending, while custom grants can expose only the permitted personal
  // surface without leaking logistics-maintenance or equipment-sales nav.
  ["work-hub", OPERATIONAL_ROLES],
  ["my-attendance", OPERATIONAL_ROLES],
  ["messenger", OPERATIONAL_ROLES],
  ["approvals", ADMIN_ROLES],
  // mail (MailUse): shared corporate mailbox. Mechanics/MEMBER are denied.
  // The platform operates the mail server out of the box; there is no
  // tenant-visible SMTP/IMAP server configuration nav item.
  ["mail", MAIL_USE_ROLES],
  // Logistics/maintenance operations — visible only to the current built-in
  // personas that map to KNL maintenance, management/executive, or affiliate
  // business-operations viewers, plus explicit per-item feature grants below.
  ["dispatch", LOGISTICS_MAINTENANCE_ROLES],
  ["dispatch-map", LOGISTICS_MAINTENANCE_ROLES],
  ["intake", LOGISTICS_MAINTENANCE_ROLES],
  ["support", LOGISTICS_MAINTENANCE_ROLES],
  ["reporting", LOGISTICS_MAINTENANCE_ROLES],
  ["collaboration", LOGISTICS_MAINTENANCE_ROLES],
  // Equipment/sales surfaces use the same intended viewer set unless a narrower
  // management guard below applies.
  ["equipment", EQUIPMENT_SALES_ROLES],
  ["financial", OPERATIONAL_ROLES],
  ["location", OPERATIONAL_ROLES],
  // catalog (sales-listing & inquiry admin, #6): ADMIN/SUPER_ADMIN only by
  // built-in role, or an explicit SalesManage custom grant.
  ["catalog", ADMIN_ROLES],
  // daily-plan (DailyPlanRequest / DailyPlanReview): MECHANIC/ADMIN/SUPER_ADMIN.
  ["daily-plan", DAILY_PLAN_ROLES],
  ["kpi", KPI_ROLES],
  // intelligence (Operations Intelligence): same executive read gate as KPI.
  // It converts recommendations to governed workflows; mechanics/receptionists
  // keep their daily execution surfaces instead of executive scenario planning.
  ["intelligence", KPI_ROLES],
  // ops (OpsDashboardRead): SUPER_ADMIN/ADMIN only, matching the
  // `RequireAdminRoute` guard on `/ops` and the backend permission matrix.
  ["ops", ADMIN_ROLES],
  ["users", ADMIN_ROLES],
  ["policy", ROLE_MANAGE_ROLES],
  ["workflows", ROLE_MANAGE_ROLES],
  ["org", ADMIN_ROLES],
  ["sites", ADMIN_ROLES],
  ["employees", EMPLOYEE_DIRECTORY_ROLES],
  ["leave-management", EMPLOYEE_DIRECTORY_ROLES],
  ["insurance-assist", EMPLOYEE_DIRECTORY_ROLES],
  ["payroll", PAYROLL_ROLES],
  ["security", ADMIN_ROLES],
  // Legacy external-account configuration is intentionally hidden. Corporate
  // mailbox hosting is platform-operated; admins manage domains/mailboxes, not
  // SMTP/IMAP host/port/password settings.
  ["email", []],
  // inspection (InspectionScheduleManage): ADMIN/SUPER_ADMIN only, matching the
  // backend matrix row [D, D, A, D, A] and the list-schedules read gate.
  ["inspection", ADMIN_ROLES],
  // equipment-manage (EquipmentManage): ADMIN/EXECUTIVE/SUPER_ADMIN only,
  // matching the backend matrix and the RequireEquipmentManageRoute guard.
  ["equipment-manage", EQUIPMENT_MANAGE_ROLES],
  // integrity (IntegrityFindingsRead/Triage): EXECUTIVE/SUPER_ADMIN only,
  // matching the backend matrix [D, D, D, D, A, A] and RequireIntegrityRoute.
  // ADMIN is intentionally excluded.
  ["integrity", INTEGRITY_ROLES],
]);

// Runtime custom-role feature grants are level-flattened for destination
// visibility: any non-deny backend grant may expose the relevant nav entry, while
// the backend still enforces request_only/limited/allow on the API operation.
const ITEM_FEATURE_GATES = new Map<string, readonly FeatureGrant[]>([
  ["work-hub", [FEATURES.WORK_ORDER_READ_ALL]],
  ["my-attendance", [FEATURES.EMPLOYEE_DIRECTORY_READ]],
  ["messenger", [FEATURES.WORK_ORDER_READ_ALL]],
  ["dispatch", [FEATURES.WORK_ORDER_READ_ALL]],
  ["dispatch-map", [FEATURES.WORK_ORDER_READ_ALL]],
  ["intake", [FEATURES.WORK_ORDER_CREATE]],
  ["support", [FEATURES.WORK_ORDER_READ_ALL]],
  ["reporting", [FEATURES.EXCEL_DOWNLOAD]],
  ["collaboration", [FEATURES.WORK_ORDER_READ_ALL]],
  ["approvals", [FEATURES.COMPLETION_REVIEW]],
  [
    "daily-plan",
    [
      FEATURES.DAILY_PLAN_REQUEST,
      FEATURES.DAILY_PLAN_REVIEW,
      FEATURES.ORG_WIDE_QUEUE_TRIAGE,
    ],
  ],
  ["kpi", [FEATURES.KPI_READ]],
  ["intelligence", [FEATURES.KPI_READ]],
  ["mail", [FEATURES.MAIL_USE]],
  ["employees", [FEATURES.EMPLOYEE_DIRECTORY_READ]],
  ["leave-management", [FEATURES.EMPLOYEE_DIRECTORY_READ]],
  ["insurance-assist", [FEATURES.EMPLOYEE_DIRECTORY_READ]],
  ["payroll", [FEATURES.PAYROLL_READ]],
  ["policy", [FEATURES.ROLE_MANAGE]],
  ["workflows", [FEATURES.ROLE_MANAGE]],
  ["equipment", [FEATURES.WORK_ORDER_READ_ALL]],
  ["equipment-manage", [FEATURES.EQUIPMENT_MANAGE]],
  ["catalog", [FEATURES.SALES_MANAGE]],
  ["inspection", [FEATURES.INSPECTION_SCHEDULE_MANAGE]],
  [
    "integrity",
    [FEATURES.INTEGRITY_FINDINGS_READ, FEATURES.INTEGRITY_FINDING_TRIAGE],
  ],
]);

/**
 * Whether a nav item is visible to a session carrying `roles`. Every
 * destination-bearing item now carries an explicit role gate (default-deny);
 * only `profile` is intentionally ungated, so a no-grant MEMBER sees Profile
 * alone (+ the /pending landing page). Items without a gate stay visible to any
 * authenticated session.
 */
export function isNavItemVisible(
  itemKey: string,
  roles: readonly string[] | undefined,
  groupRoles?: readonly string[],
  featureGrants?: readonly string[],
): boolean {
  if (itemKey === "group") return hasGroupAdminRole(groupRoles);
  const gate = ITEM_ROLE_GATES.get(itemKey);
  const featureGate = ITEM_FEATURE_GATES.get(itemKey);
  if (!gate && !featureGate) return true;
  return (
    (gate ? hasAnyRole(roles, gate) : false) ||
    (featureGate ? hasAnyFeatureGrant(featureGrants, featureGate) : false)
  );
}

export const NAV_GROUPS = [
  {
    key: "personal",
    label: "nav.groups.personal",
    items: [
      {
        key: "work-hub",
        href: "/work-hub",
        labelKey: "nav.work-hub",
        Icon: Inbox,
      },
      {
        key: "my-attendance",
        href: "/attendance",
        labelKey: "nav.my-attendance",
        Icon: CalendarClock,
      },
      {
        key: "approvals",
        href: "/approvals",
        labelKey: "nav.approvals",
        Icon: CheckSquare,
      },
      {
        key: "messenger",
        href: "/messenger",
        labelKey: "nav.messenger",
        Icon: MessageSquare,
      },
      {
        key: "mail",
        href: "/mail",
        labelKey: "nav.mail",
        Icon: Mail,
      },
    ],
  },
  {
    key: "operations",
    label: "nav.groups.operations",
    items: [
      {
        key: "dispatch",
        href: "/dispatch",
        labelKey: "nav.dispatch",
        Icon: ClipboardList,
      },
      // dispatch-map (geographic dispatch view): its data read is
      // WorkOrderReadAll, so it is gated to intended logistics-maintenance
      // viewers (not a bare MEMBER), like dispatch/intake/support.
      {
        key: "dispatch-map",
        href: "/dispatch-map",
        labelKey: "nav.dispatch-map",
        Icon: MapIcon,
      },
      {
        key: "intake",
        href: "/intake",
        labelKey: "nav.intake",
        Icon: FilePlus,
      },
      {
        key: "daily-plan",
        href: "/daily-plan",
        labelKey: "nav.daily-plan",
        Icon: CalendarCheck,
      },
      {
        key: "collaboration",
        href: "/collaboration",
        labelKey: "nav.collaboration",
        Icon: CalendarDays,
      },
      {
        key: "inspection",
        href: "/inspection",
        labelKey: "nav.inspection",
        Icon: CalendarClock,
      },
      {
        key: "support",
        href: "/support",
        labelKey: "nav.support",
        Icon: LifeBuoy,
      },
    ],
  },
  {
    key: "executive",
    label: "nav.groups.executive",
    items: [
      { key: "kpi", href: "/kpi", labelKey: "nav.kpi", Icon: BarChart2 },
      {
        key: "intelligence",
        href: "/intelligence",
        labelKey: "nav.intelligence",
        Icon: Gauge,
      },
      { key: "ops", href: "/ops", labelKey: "nav.ops", Icon: Gauge },
      // reporting (ExcelDownload): [A,A,A,A,A] for the five granted roles in the
      // backend matrix — they may download the work-diary / daily-status
      // workbooks, so the item is gated to the operational roles (not MEMBER).
      {
        key: "reporting",
        href: "/reporting",
        labelKey: "nav.reporting",
        Icon: FileSpreadsheet,
      },
      // integrity (#12 / #34): governance findings (review-needed anomalies).
      // EXECUTIVE/SUPER_ADMIN only — gated by ITEM_ROLE_GATES("integrity") and
      // the RequireIntegrityRoute guard on /integrity.
      {
        key: "integrity",
        href: "/integrity",
        labelKey: "nav.integrity",
        Icon: ShieldAlert,
      },
    ],
  },
  {
    key: "assets",
    label: "nav.groups.assets",
    items: [
      // equipment (browse list): the five operational roles may browse the fleet.
      // The read gate is WorkOrderReadAll; a bare MEMBER is default-denied.
      {
        key: "equipment",
        href: "/equipment",
        labelKey: "nav.equipment",
        Icon: List,
      },
      // equipment-manage (CRUD): gated to EquipmentManage holders
      // (ADMIN/EXECUTIVE/SUPER_ADMIN), matching the backend matrix and the
      // route guard on /equipment/manage.
      {
        key: "equipment-manage",
        href: "/equipment/manage",
        labelKey: "nav.equipment-manage",
        Icon: Settings2,
      },
      // catalog (sales-listing & inquiry admin, #6): ADMIN/SUPER_ADMIN only.
      {
        key: "catalog",
        href: "/catalog",
        labelKey: "nav.catalog",
        Icon: Store,
      },
    ],
  },
  {
    key: "payroll",
    label: "nav.groups.payroll",
    items: [
      {
        key: "payroll",
        href: "/payroll",
        labelKey: "nav.payroll",
        Icon: Calculator,
      },
    ],
  },
  {
    key: "finance",
    label: "nav.groups.finance",
    items: [
      {
        key: "financial",
        href: "/financial",
        labelKey: "nav.financial",
        Icon: Receipt,
      },
    ],
  },
  {
    key: "organization",
    label: "nav.groups.organization",
    items: [
      {
        key: "group",
        href: "/settings/group",
        labelKey: "nav.group",
        Icon: Network,
      },
      {
        key: "org",
        href: "/settings/org",
        labelKey: "nav.org",
        Icon: Building2,
      },
      {
        key: "sites",
        href: "/settings/sites",
        labelKey: "nav.sites",
        Icon: Contact,
      },
      {
        key: "location",
        href: "/settings/location",
        labelKey: "nav.location",
        Icon: MapPin,
      },
      {
        key: "employees",
        href: "/settings/employees",
        labelKey: "nav.employees",
        Icon: Users,
      },
      {
        key: "leave-management",
        href: "/hr/leave-management",
        labelKey: "nav.leave-management",
        Icon: CalendarCheck,
      },
      {
        key: "insurance-assist",
        href: "/hr/insurance",
        labelKey: "nav.insurance-assist",
        Icon: ShieldCheck,
      },
    ],
  },
  {
    key: "identity",
    label: "nav.groups.identity",
    items: [
      // IAM/user administration, not HR. HR will own employee/attendance/leave
      // once those modules exist; this page issues OTPs, roles, and branch scope.
      {
        key: "users",
        href: "/settings/users",
        labelKey: "nav.users",
        Icon: Users,
      },
      {
        key: "policy",
        href: "/settings/policy",
        labelKey: "nav.policy",
        Icon: ShieldAlert,
      },
      {
        key: "workflows",
        href: "/settings/workflows",
        labelKey: "nav.workflows",
        Icon: ShieldCheck,
      },
      {
        key: "security",
        href: "/settings/security",
        labelKey: "nav.security",
        Icon: ShieldCheck,
      },
    ],
  },
  {
    key: "settings",
    label: "nav.groups.settings",
    items: [
      {
        key: "profile",
        href: "/settings/profile",
        labelKey: "nav.profile",
        Icon: UserCircle,
      },
    ],
  },
] as const;

export type NavGroupKey = (typeof NAV_GROUPS)[number]["key"];
export type NavItemKey = (typeof NAV_GROUPS)[number]["items"][number]["key"];

export interface VisibleNavItem {
  key: string;
  href: string;
  labelKey: string;
  groupKey: string;
  groupLabelKey: string;
  Icon: LucideIcon;
}

/**
 * Flatten the role-gated nav registry for shell-level surfaces such as the
 * command palette and route breadcrumbs. The sidebar remains the visual rail;
 * this helper keeps every secondary navigation surface on the same
 * deny-by-default visibility rules.
 */
export function visibleNavItemsForRoles(
  roles: readonly string[] | undefined,
  groupRoles?: readonly string[],
  featureGrants?: readonly string[],
): VisibleNavItem[] {
  return NAV_GROUPS.flatMap((group) =>
    group.items
      .filter((item) => isNavItemVisible(item.key, roles, groupRoles, featureGrants))
      .map((item) => ({
        key: item.key,
        href: item.href,
        labelKey: item.labelKey,
        groupKey: group.key,
        groupLabelKey: group.label,
        Icon: item.Icon,
      })),
  );
}

export function hasGrantedConsoleAccess(
  roles: readonly string[] | undefined,
  groupRoles?: readonly string[],
  featureGrants?: readonly string[],
): boolean {
  return visibleNavItemsForRoles(roles, groupRoles, featureGrants).some(
    (item) => item.key !== "profile",
  );
}

/**
 * Resolve the closest visible nav destination for a path. Exact matches win,
 * then the longest prefix match supports object detail routes such as
 * `/equipment/:id` without misclassifying `/equipment/manage`.
 */
export function visibleNavItemForPath(
  pathname: string,
  roles: readonly string[] | undefined,
  groupRoles?: readonly string[],
  featureGrants?: readonly string[],
): VisibleNavItem | undefined {
  const items = visibleNavItemsForRoles(roles, groupRoles, featureGrants);
  const exact = items.find((item) => item.href === pathname);
  if (exact) return exact;
  return items
    .filter((item) => pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
