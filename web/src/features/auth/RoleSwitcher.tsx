import { UserCog } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { useAuth } from "../../context/auth";
import { koDevAuth as copy } from "../../i18n/koDevAuth";
import { isLocalDevBuild } from "./localDev";
import { parseDevAuthAccessToken } from "./devAuthResponse";
import {
  DEFAULT_DEV_BRANCH_ID,
  DEFAULT_DEV_ROLE,
  DEV_AUTH_MENU_SENTINEL,
  DEV_AUTH_PRESET_SENTINEL,
  DEV_ROLE_OPTIONS,
  isUuid,
  KNL_DEV_BRANCHES,
  KNL_DEV_ORG_ID,
  normalizeBranchIds,
  type DevRole,
} from "./devRolePresets";

function errorFor(response: Response): string {
  if (response.status === 404) {
    return response.headers.get("content-type")?.includes("application/json")
      ? copy.unknownSelection
      : copy.routeUnavailable;
  }
  if (response.status === 400 || response.status === 422)
    return copy.invalidSelection;
  if (response.status === 401 || response.status === 403) return copy.forbidden;
  if (response.status >= 500) return copy.serverFailed;
  return copy.failed;
}

export function RoleSwitcher() {
  const { beginTokenAcceptance, acceptTokens } = useAuth();
  const [advanced, setAdvanced] = useState(false);
  const [role, setRole] = useState<DevRole>(DEFAULT_DEV_ROLE);
  const [branchId, setBranchId] = useState<string>(DEFAULT_DEV_BRANCH_ID);
  const [orgId, setOrgId] = useState<string>(KNL_DEV_ORG_ID);
  const [branchIds, setBranchIds] = useState<string>(DEFAULT_DEV_BRANCH_ID);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!isLocalDevBuild()) return null;

  const selectedBranch =
    KNL_DEV_BRANCHES.find((branch) => branch.id === branchId) ??
    KNL_DEV_BRANCHES[0];
  const selectedBranchLabel = copy.branches[selectedBranch.key];
  const roleLabel = copy.roles[role];
  const resolvedOrgId = advanced ? orgId.trim() : KNL_DEV_ORG_ID;
  const resolvedBranchIds = advanced
    ? normalizeBranchIds(branchIds)
    : [branchId];
  const organizationWide = advanced && resolvedBranchIds.length === 0;

  async function handleSwitch() {
    setError(undefined);
    if (!resolvedOrgId) {
      setError(copy.orgRequired);
      return;
    }
    if (!isUuid(resolvedOrgId) || resolvedBranchIds.some((id) => !isUuid(id))) {
      setError(copy.invalidIdentifiers);
      return;
    }

    const lease = beginTokenAcceptance?.();
    if (!lease) {
      setError(copy.failed);
      return;
    }
    setPending(true);
    let response: Response;
    try {
      const baseUrl =
        import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
      response = await fetch(`${baseUrl}/api/v1/dev-auth/session`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Transport": "cookie",
        },
        body: JSON.stringify({
          org_id: resolvedOrgId,
          role,
          branch_ids: resolvedBranchIds,
        }),
      });
    } catch {
      setPending(false);
      setError(copy.networkFailed);
      return;
    }

    try {
      if (!response.ok) {
        setError(errorFor(response));
        return;
      }
      const accessToken = await parseDevAuthAccessToken(response);
      if (!accessToken) {
        setError(copy.protocolFailed);
        return;
      }
      if (
        acceptTokens(
          { access_token: accessToken, requires_passkey_setup: false },
          lease,
        ) === false
      ) {
        setError(copy.failed);
      }
    } catch {
      setError(copy.protocolFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="grid gap-3 border-t border-line pt-4"
      aria-labelledby="dev-role-switch-title"
      data-dev-auth-copy={copy.copySentinel}
      data-dev-auth-menu={DEV_AUTH_MENU_SENTINEL}
      data-dev-auth-preset={DEV_AUTH_PRESET_SENTINEL}
    >
      <div className="grid gap-1">
        <h3
          id="dev-role-switch-title"
          className="text-sm font-semibold text-ink"
        >
          {copy.title}
        </h3>
        <p className="text-sm text-steel">{copy.description}</p>
        <p className="text-sm font-medium text-ink">{copy.organization}</p>
      </div>

      <label className="grid gap-1 text-sm font-medium text-steel">
        {copy.roleLabel}
        <Select
          value={role}
          onChange={(event) => {
            setRole(event.currentTarget.value as DevRole);
          }}
        >
          {DEV_ROLE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {copy.roles[option]}
            </option>
          ))}
        </Select>
      </label>

      {!advanced ? (
        <label className="grid gap-1 text-sm font-medium text-steel">
          {copy.branchLabel}
          <Select
            value={branchId}
            onChange={(event) => {
              setBranchId(event.currentTarget.value);
            }}
          >
            {KNL_DEV_BRANCHES.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {copy.branches[branch.key]}
              </option>
            ))}
          </Select>
        </label>
      ) : (
        <>
          <label className="grid gap-1 text-sm font-medium text-steel">
            {copy.orgLabel}
            <Input
              value={orgId}
              onChange={(event) => {
                setOrgId(event.currentTarget.value);
              }}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-steel">
            {copy.branchIdsLabel}
            <Input
              value={branchIds}
              onChange={(event) => {
                setBranchIds(event.currentTarget.value);
              }}
            />
          </label>
          {organizationWide ? (
            <p role="status" className="text-sm text-steel">
              {copy.organizationWideWarning}
            </p>
          ) : null}
        </>
      )}

      <Button
        type="button"
        variant="ghost"
        className="justify-self-start"
        onClick={() => {
          setAdvanced((value) => !value);
        }}
      >
        {advanced ? copy.advancedClose : copy.advancedOpen}
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={() => void handleSwitch()}
      >
        <UserCog aria-hidden="true" size={18} />
        {pending
          ? copy.submitting
          : copy.submit(selectedBranchLabel, roleLabel)}
      </Button>
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
