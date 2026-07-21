import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  exitGroupTenantContext,
  listGroupAdminGroups,
  startGroupTenantContext,
  type GroupAdminGroup,
  type GroupAdminMemberOrg,
} from "../../api/groupAdmin";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";
import { hasGroupAdminRole } from "../../components/shell/nav";

type LoadState = "idle" | "loading" | "error";

interface GroupScopeOrgOption extends GroupAdminMemberOrg {
  groupName: string;
}

function flattenOrgOptions(groups: readonly GroupAdminGroup[]): GroupScopeOrgOption[] {
  return groups
    .flatMap((group) =>
      group.members.map((member) => ({ ...member, groupName: group.name })),
    )
    .sort((a, b) =>
      a.groupName.localeCompare(b.groupName, "ko") ||
      a.name.localeCompare(b.name, "ko") ||
      a.slug.localeCompare(b.slug),
    );
}

function destinationAfterSelectingOrg(pathname: string, search: string): string {
  if (pathname === "/settings/group" || pathname.startsWith("/platform")) {
    return "/overview";
  }
  return `${pathname}${search}`;
}

/**
 * Shell-level scope switcher for tenant-side GROUP_ADMIN users.
 *
 * "그룹 전체" is the source group-admin console. Selecting a subsidiary mints a
 * short-lived delegated tenant context. The token is still pinned to exactly one
 * org/RLS boundary; switching back exits that context and returns to the group
 * console. Server-side resolvers re-check the live group grant on every call —
 * this component is only the ergonomic control surface.
 */
export function GroupScopeSwitcher() {
  const {
    session,
    viewAs,
    enterViewAs,
    exitViewAs,
    refreshAuthority,
    sourceRefreshAuthority,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [groups, setGroups] = useState<GroupAdminGroup[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const switchGenerationRef = useRef(0);

  const sourceIsGroupAdminContext = viewAs?.source === "GROUP_ADMIN";
  const sourceToken = sourceIsGroupAdminContext
    ? viewAs.platformSession.access_token
    : session?.access_token;
  const sourceAuthority = sourceIsGroupAdminContext
    ? sourceRefreshAuthority
    : refreshAuthority;
  const eligible =
    sourceIsGroupAdminContext || hasGroupAdminRole(session?.group_roles);

  const orgOptions = useMemo(() => flattenOrgOptions(groups), [groups]);
  const selectedValue = sourceIsGroupAdminContext
    ? `org:${viewAs.actingOrgId}`
    : "group:all";

  const load = useCallback(async () => {
    if (!eligible || !sourceToken) {
      setGroups([]);
      return;
    }
    setLoadState("loading");
    setError(undefined);
    try {
      setGroups(await listGroupAdminGroups(sourceToken, sourceAuthority));
      setLoadState("idle");
    } catch {
      setGroups([]);
      setLoadState("error");
      setError(ko.shell.scopeSwitcher.loadFailed);
    }
  }, [eligible, sourceAuthority, sourceToken]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(
    () => () => {
      switchGenerationRef.current += 1;
    },
    [],
  );

  function isCurrentSwitch(generation: number): boolean {
    return switchGenerationRef.current === generation;
  }

  if (!eligible) return null;

  async function switchToGroupAll(generation: number) {
    if (sourceIsGroupAdminContext) {
      if (!sourceToken) throw new Error("missing group-admin source token");
      await exitGroupTenantContext(
        sourceToken,
        viewAs.actingOrgId,
        sourceAuthority,
      );
      if (!isCurrentSwitch(generation)) return;
      if (!exitViewAs()) {
        throw new Error("group-admin context exit was rejected");
      }
    }
    if (isCurrentSwitch(generation)) {
      void navigate("/settings/group");
    }
  }

  async function switchToOrg(orgId: string, generation: number) {
    if (!sourceToken) throw new Error("missing group-admin source token");
    if (sourceIsGroupAdminContext && viewAs.actingOrgId === orgId) return;
    const org = orgOptions.find((option) => option.id === orgId);
    const result = await startGroupTenantContext(
      sourceToken,
      orgId,
      sourceAuthority,
    );
    if (!isCurrentSwitch(generation)) return;
    if (sourceIsGroupAdminContext) {
      await exitGroupTenantContext(
        sourceToken,
        viewAs.actingOrgId,
        sourceAuthority,
      );
      if (!isCurrentSwitch(generation)) return;
    }
    if (
      enterViewAs({
        token: result.access_token,
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: result.acting_org_id,
        actingOrgName: result.acting_org_name,
        actingRole: result.acting_role,
      }) !== true
    ) {
      throw new Error("group-admin context replacement was rejected");
    }
    if (!isCurrentSwitch(generation)) return;
    void navigate(destinationAfterSelectingOrg(location.pathname, location.search), {
      replace: sourceIsGroupAdminContext,
      state: org ? { groupScopeOrgName: org.name } : undefined,
    });
  }

  async function handleChange(value: string) {
    const generation = switchGenerationRef.current + 1;
    switchGenerationRef.current = generation;
    setError(undefined);
    setSwitching(true);
    try {
      if (value === "group:all") {
        await switchToGroupAll(generation);
      } else if (value.startsWith("org:")) {
        await switchToOrg(value.slice("org:".length), generation);
      }
    } catch {
      if (isCurrentSwitch(generation)) {
        setError(ko.shell.scopeSwitcher.switchFailed);
      }
    } finally {
      if (isCurrentSwitch(generation)) {
        setSwitching(false);
      }
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <label
        htmlFor="group-scope-switcher"
        className="sr-only whitespace-nowrap text-xs font-semibold text-console-steel xl:not-sr-only"
      >
        {ko.shell.scopeSwitcher.label}
      </label>
      <select
        id="group-scope-switcher"
        aria-label={ko.shell.scopeSwitcher.ariaLabel}
        value={selectedValue}
        disabled={switching || loadState === "loading"}
        onChange={(event) => {
          void handleChange(event.currentTarget.value);
        }}
        className={cn(
          "w-36 rounded-md border border-console-border bg-console-surface px-2 py-1.5 text-sm font-medium text-console-ink shadow-console focus-visible:outline-2 focus-visible:outline-console-teal disabled:cursor-wait disabled:opacity-60 sm:w-44 lg:w-52",
          error ? "border-console-danger-bd text-console-danger-tx" : undefined,
        )}
      >
        <option value="group:all">{ko.shell.scopeSwitcher.groupAll}</option>
        {orgOptions.map((org) => (
          <option key={org.id} value={`org:${org.id}`}>
            {org.groupName} / {org.name}
          </option>
        ))}
      </select>
      <span className="sr-only" role="status" aria-live="polite">
        {switching
          ? ko.shell.scopeSwitcher.switching
          : error ?? (loadState === "error" ? ko.shell.scopeSwitcher.loadFailed : "")}
      </span>
    </div>
  );
}
