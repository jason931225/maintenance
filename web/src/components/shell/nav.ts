import {
  BarChart2,
  Building2,
  CalendarCheck,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  Contact,
  FilePlus,
  FileSpreadsheet,
  Gauge,
  LifeBuoy,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  Receipt,
  ShieldCheck,
  UserCircle,
  Users,
  Wrench,
} from "lucide-react";

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
  MECHANIC: "MECHANIC",
  RECEPTIONIST: "RECEPTIONIST",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** True when `roles` contains at least one of `allowed`. */
export function hasAnyRole(
  roles: readonly string[] | undefined,
  allowed: readonly Role[],
): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some((role) => (allowed as readonly string[]).includes(role));
}

const ADMIN_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.SUPER_ADMIN];
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
 * Per-item role gate. `undefined` (or omitted) means the item is visible to any
 * authenticated role. The role sets are derived from the backend permission
 * matrix so the nav never shows a page the backend would 403, nor hides one a
 * role is entitled to:
 *  - intake (WorkOrderCreate/EditIntake): every role has at least Limited -> all roles.
 *  - approvals (CompletionReview): ADMIN/SUPER_ADMIN only.
 *  - kpi (KpiRead): ADMIN/EXECUTIVE/SUPER_ADMIN.
 *  - security settings (UserManage / admin OTP issuance): ADMIN/SUPER_ADMIN,
 *    matching the `RequireAdminRoute` guard on `/settings/security`.
 *  - users / org (UserManage, region/branch management): ADMIN/SUPER_ADMIN,
 *    matching the `RequireAdminRoute` guards on `/settings/users` & `/settings/org`.
 *  - dispatch/messenger/support/equipment/location: all authenticated roles.
 */
const ITEM_ROLE_GATES = new Map<string, readonly Role[]>([
  ["approvals", ADMIN_ROLES],
  // daily-plan (DailyPlanRequest / DailyPlanReview): MECHANIC/ADMIN/SUPER_ADMIN.
  ["daily-plan", DAILY_PLAN_ROLES],
  ["kpi", KPI_ROLES],
  // ops (OpsDashboardRead): SUPER_ADMIN/ADMIN only, matching the
  // `RequireAdminRoute` guard on `/ops` and the backend permission matrix.
  ["ops", ADMIN_ROLES],
  ["users", ADMIN_ROLES],
  ["org", ADMIN_ROLES],
  ["sites", ADMIN_ROLES],
  ["security", ADMIN_ROLES],
  // inspection (InspectionScheduleManage): ADMIN/SUPER_ADMIN only, matching the
  // backend matrix row [D, D, A, D, A] and the list-schedules read gate.
  ["inspection", ADMIN_ROLES],
]);

/**
 * Whether a nav item is visible to a session carrying `roles`. Items without an
 * explicit gate are visible to any authenticated role.
 */
export function isNavItemVisible(
  itemKey: string,
  roles: readonly string[] | undefined,
): boolean {
  const gate = ITEM_ROLE_GATES.get(itemKey);
  if (!gate) return true;
  return hasAnyRole(roles, gate);
}

export const NAV_GROUPS = [
  {
    key: "operations",
    label: "nav.groups.operations",
    items: [
      { key: "dispatch",  href: "/dispatch",  labelKey: "nav.dispatch",  Icon: ClipboardList },
      // dispatch-map (geographic dispatch view): ungated. Its data read is
      // WorkOrderReadAll (every authenticated role), so it is visible to all,
      // like dispatch/intake/messenger/support.
      { key: "dispatch-map", href: "/dispatch-map", labelKey: "nav.dispatch-map", Icon: MapIcon },
      { key: "intake",    href: "/intake",    labelKey: "nav.intake",    Icon: FilePlus },
      { key: "approvals", href: "/approvals", labelKey: "nav.approvals", Icon: CheckSquare },
      { key: "daily-plan", href: "/daily-plan", labelKey: "nav.daily-plan", Icon: CalendarCheck },
      { key: "inspection", href: "/inspection", labelKey: "nav.inspection", Icon: CalendarClock },
      { key: "messenger", href: "/messenger", labelKey: "nav.messenger", Icon: MessageSquare },
      { key: "support",   href: "/support",   labelKey: "nav.support",   Icon: LifeBuoy },
    ],
  },
  {
    key: "data",
    label: "nav.groups.data",
    items: [
      { key: "kpi",       href: "/kpi",       labelKey: "nav.kpi",       Icon: BarChart2 },
      { key: "ops",       href: "/ops",       labelKey: "nav.ops",       Icon: Gauge },
      // reporting (ExcelDownload): [A,A,A,A,A] in the backend matrix — every
      // role may download the work-diary / daily-status workbooks, so the item
      // is ungated like the other shared pages.
      { key: "reporting", href: "/reporting", labelKey: "nav.reporting", Icon: FileSpreadsheet },
      { key: "equipment", href: "/equipment", labelKey: "nav.equipment", Icon: Wrench },
      // financial: the page surfaces purchase requests, whose read gate
      // (PurchaseRequestRead) is at least Limited for every role
      // ([A, L, A, A, A] in the backend matrix), so the item is ungated like the
      // other shared pages. Per-action controls inside the page are role-gated
      // to their specific backend Feature.
      { key: "financial", href: "/financial", labelKey: "nav.financial", Icon: Receipt },
    ],
  },
  {
    key: "org",
    label: "nav.groups.org",
    items: [
      { key: "users", href: "/settings/users", labelKey: "nav.users", Icon: Users },
      { key: "org",   href: "/settings/org",   labelKey: "nav.org",   Icon: Building2 },
      { key: "sites", href: "/settings/sites", labelKey: "nav.sites", Icon: Contact },
    ],
  },
  {
    key: "settings",
    label: "nav.groups.settings",
    items: [
      { key: "profile",   href: "/settings/profile",  labelKey: "nav.profile",  Icon: UserCircle },
      { key: "location",  href: "/settings/location", labelKey: "nav.location", Icon: MapPin },
      { key: "security",  href: "/settings/security", labelKey: "nav.security", Icon: ShieldCheck },
    ],
  },
] as const;

export type NavGroupKey = (typeof NAV_GROUPS)[number]["key"];
export type NavItemKey = (typeof NAV_GROUPS)[number]["items"][number]["key"];
