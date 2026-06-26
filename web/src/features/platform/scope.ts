import type { PlatformOrg, PlatformTenantHealth } from "../../api/platform";
import { ko } from "../../i18n/ko";

export type PlatformScopeValue = "all" | `group:${string}` | `org:${string}`;

export interface PlatformScopeOption {
  value: PlatformScopeValue;
  label: string;
}

type ScopedTenantRow = Pick<
  PlatformOrg | PlatformTenantHealth,
  "id" | "name" | "slug" | "group_id" | "group_name" | "group_slug"
>;

/** Build scope options for platform-wide, group, and individual-org views. */
export function buildPlatformScopeOptions(
  rows: readonly ScopedTenantRow[],
): PlatformScopeOption[] {
  const groupOptions = new Map<string, PlatformScopeOption>();
  const options: PlatformScopeOption[] = [
    { value: "all", label: ko.platform.scope.all },
  ];

  for (const row of rows) {
    if (!row.group_id) continue;
    if (!groupOptions.has(row.group_id)) {
      groupOptions.set(row.group_id, {
        value: `group:${row.group_id}`,
        label: `${ko.platform.scope.groupPrefix} ${row.group_name ?? row.group_slug ?? row.group_id}`,
      });
    }
  }

  options.push(...groupOptions.values());
  options.push(
    ...rows.map((row) => ({
      value: `org:${row.id}` as const,
      label: `${ko.platform.scope.orgPrefix} ${row.name} (${row.slug})`,
    })),
  );
  return options;
}

/** Filter platform rows to the selected all/group/org scope. */
export function filterByPlatformScope<T extends ScopedTenantRow>(
  rows: readonly T[],
  scope: PlatformScopeValue,
): T[] {
  if (scope === "all") return [...rows];
  if (scope.startsWith("group:")) {
    const groupId = scope.slice("group:".length);
    return rows.filter((row) => row.group_id === groupId);
  }
  const orgId = scope.slice("org:".length);
  return rows.filter((row) => row.id === orgId);
}

/** Human-readable group label for rows that may not belong to a group yet. */
export function platformGroupLabel(row: ScopedTenantRow): string {
  return row.group_name ?? row.group_slug ?? ko.platform.scope.ungrouped;
}
