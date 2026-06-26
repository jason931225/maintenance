import {
  BarChart2,
  Building2,
  CalendarCheck,
  CalendarClock,
  CheckSquare,
  ClipboardList,
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
  Receipt,
  Settings2,
  Mail,
  ShieldAlert,
  ShieldCheck,
  UserCircle,
  Users,
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
  // A just-signed-up user with no role grant yet. The backend default-denies
  // every Feature but Login for MEMBER, so the nav must default-deny too: a
  // MEMBER session sees only Profile (+ the /pending landing page).
  MEMBER: "MEMBER",
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

/**
 * A "pending" session: a just-signed-up user who holds no operational role yet —
 * either an empty/absent roles claim or the placeholder `["MEMBER"]`. The backend
 * default-denies every Feature but Login for this session, so the app routes it
 * to /pending and the nav default-denies every gated destination (only Profile
 * remains). Mirrors the backend authz reality so the nav never shows a 403 link.
 */
export function isPendingMember(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return true;
  return roles.every((role) => role === ROLES.MEMBER);
}

const ADMIN_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.SUPER_ADMIN];
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
/**
 * Roles that may read/triage integrity findings (backend `IntegrityFindingsRead`
 * / `IntegrityFindingTriage`, matrix row [D, D, D, D, A, A]). EXECUTIVE +
 * SUPER_ADMIN only — ADMIN is deliberately denied (labor-law sensitivity: an
 * ADMIN must not read findings about themselves). Mirrors RequireIntegrityRoute.
 */
const INTEGRITY_ROLES: readonly Role[] = [ROLES.EXECUTIVE, ROLES.SUPER_ADMIN];

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
  // Shared pages — visible to every granted role, but NOT to a bare MEMBER. The
  // backend allows these for any operational role (e.g. WorkOrderReadAll /
  // WorkOrderCreate / ExcelDownload / PurchaseRequestRead are at least Limited
  // for all five), while default-denying them for a no-grant MEMBER. Gating to
  // OPERATIONAL_ROLES mirrors that: the five roles still see them; a MEMBER does
  // not (so the nav never advertises a destination the backend would 403).
  ["dispatch", OPERATIONAL_ROLES],
  ["dispatch-map", OPERATIONAL_ROLES],
  // intake (WorkOrderCreate/EditIntake): the five operational roles, not MEMBER.
  ["intake", OPERATIONAL_ROLES],
  ["messenger", OPERATIONAL_ROLES],
  ["support", OPERATIONAL_ROLES],
  ["reporting", OPERATIONAL_ROLES],
  ["equipment", OPERATIONAL_ROLES],
  ["financial", OPERATIONAL_ROLES],
  ["location", OPERATIONAL_ROLES],
  ["approvals", ADMIN_ROLES],
  // catalog (sales-listing & inquiry admin, #6): ADMIN/SUPER_ADMIN only,
  // matching the `RequireAdminRoute` guard on `/catalog`.
  ["catalog", ADMIN_ROLES],
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
  // email (MailAccountManage): the tenant corporate mail-account config. The
  // backend matrix grants MailAccountManage to ADMIN/SUPER_ADMIN only, matching
  // the `RequireAdminRoute` guard on `/settings/email`.
  ["email", ADMIN_ROLES],
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
      {
        key: "dispatch",
        href: "/dispatch",
        labelKey: "nav.dispatch",
        Icon: ClipboardList,
      },
      // dispatch-map (geographic dispatch view): its data read is
      // WorkOrderReadAll, so it is gated to the five operational roles (not a
      // bare MEMBER), like dispatch/intake/messenger/support.
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
        key: "approvals",
        href: "/approvals",
        labelKey: "nav.approvals",
        Icon: CheckSquare,
      },
      {
        key: "daily-plan",
        href: "/daily-plan",
        labelKey: "nav.daily-plan",
        Icon: CalendarCheck,
      },
      {
        key: "inspection",
        href: "/inspection",
        labelKey: "nav.inspection",
        Icon: CalendarClock,
      },
      {
        key: "messenger",
        href: "/messenger",
        labelKey: "nav.messenger",
        Icon: MessageSquare,
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
    key: "finance",
    label: "nav.groups.finance",
    items: [
      // Finance/procurement now. Payroll remains a separate high-sensitivity
      // domain in the product architecture and must not be mislabeled here until
      // the payroll module exists.
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
      // email (MailAccountManage): tenant corporate mail-account config. ADMIN/
      // SUPER_ADMIN only — gated by ITEM_ROLE_GATES("email") and the
      // RequireAdminRoute guard on /settings/email.
      {
        key: "email",
        href: "/settings/email",
        labelKey: "nav.email",
        Icon: Mail,
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
