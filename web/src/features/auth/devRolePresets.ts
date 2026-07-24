export const DEV_AUTH_PRESET_SENTINEL = "__DEV_AUTH_KNL_PRESET_SENTINEL__";
export const DEV_AUTH_MENU_SENTINEL = "__DEV_AUTH_LOCAL_ROLE_MENU__";

export const DEV_ROLE_OPTIONS = [
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
] as const;

export type DevRole = (typeof DEV_ROLE_OPTIONS)[number];

/** Local-only seed identities. These IDs are never shown in the primary flow. */
export const KNL_DEV_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

export const KNL_DEV_BRANCHES = [
  { id: "00000000-0000-0000-0000-0000000000c1", key: "changwon" },
  { id: "00000000-0000-0000-0000-0000000000c2", key: "busan" },
] as const;

export const DEFAULT_DEV_ROLE: DevRole = "ADMIN";
export const DEFAULT_DEV_BRANCH_ID = KNL_DEV_BRANCHES[0].id;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Normalizes comma-separated branch IDs while retaining first-occurrence order. */
export function normalizeBranchIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
