import { UserCog } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";

const ROLE_OPTIONS = [
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
] as const;

/** KNL Logistics — tenant #1, seeded by every migration/cold-start (`OrgId::knl()`). */
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

function roleLabel(role: string): string {
  const roles = ko.platform.viewAs.roles as Record<string, string>;
  return roles[role] ?? role;
}

/** Same predicate every prior dev-only affordance used: DEV build, local host. */
function isLocalDevBuild(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const { hostname } = window.location;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Local role-switch sign-in. Mints a REAL signed session for any role/org/
 * branch combo via the backend's `dev-auth` endpoint — compiled out entirely
 * in non-dev builds (see `mnt-gate-dev-auth-absence`), so this renders nothing
 * unless both the frontend DEV build AND that backend feature are present.
 * Replaces the deleted dev-preview fixture auto-login: this hits the real API
 * and a real backing user row, so every page renders real data afterward.
 */
export function RoleSwitcher() {
  const { acceptTokens } = useAuth();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]>("SUPER_ADMIN");
  const [orgId, setOrgId] = useState(DEFAULT_ORG_ID);
  const [branchIds, setBranchIds] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!isLocalDevBuild()) return null;

  async function handleSwitch() {
    setError(undefined);
    if (!orgId.trim()) {
      setError(ko.auth.roleSwitcher.orgRequired);
      return;
    }
    setPending(true);
    try {
      const baseUrl = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
      const response = await fetch(`${baseUrl}/api/v1/dev-auth/session`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Transport": "cookie",
        },
        body: JSON.stringify({
          org_id: orgId.trim(),
          role,
          branch_ids: branchIds
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        }),
      });
      if (!response.ok) {
        setError(ko.auth.roleSwitcher.failed);
        return;
      }
      const data = (await response.json()) as { access_token: string };
      acceptTokens({ access_token: data.access_token, requires_passkey_setup: false });
    } catch {
      setError(ko.auth.roleSwitcher.failed);
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="justify-self-start"
        onClick={() => {
          setOpen(true);
        }}
      >
        <UserCog aria-hidden="true" size={18} />
        {ko.auth.roleSwitcher.reveal}
      </Button>
    );
  }

  return (
    <div className="grid gap-3 border-t border-line pt-4">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-ink">
          {ko.auth.roleSwitcher.title}
        </h3>
        <p className="text-sm text-steel">{ko.auth.roleSwitcher.description}</p>
      </div>

      <label className="grid gap-1 text-sm font-medium text-steel">
        {ko.auth.roleSwitcher.roleLabel}
        <Select
          value={role}
          onChange={(event) => {
            setRole(event.currentTarget.value as (typeof ROLE_OPTIONS)[number]);
          }}
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {roleLabel(option)}
            </option>
          ))}
        </Select>
      </label>

      <label className="grid gap-1 text-sm font-medium text-steel">
        {ko.auth.roleSwitcher.orgLabel}
        <Input
          value={orgId}
          onChange={(event) => {
            setOrgId(event.currentTarget.value);
          }}
        />
      </label>

      <label className="grid gap-1 text-sm font-medium text-steel">
        {ko.auth.roleSwitcher.branchLabel}
        <Input
          value={branchIds}
          onChange={(event) => {
            setBranchIds(event.currentTarget.value);
          }}
        />
      </label>

      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          void handleSwitch();
        }}
      >
        <UserCog aria-hidden="true" size={18} />
        {pending ? ko.auth.roleSwitcher.submitting : ko.auth.roleSwitcher.submit}
      </Button>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
