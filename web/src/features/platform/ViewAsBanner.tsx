import { LogOut, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { exitViewAs as exitViewAsApi } from "../../api/platform";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";

/**
 * Persistent, unmissable banner shown on EVERY page while a platform operator is
 * viewing a tenant read-only. Renders nothing when not impersonating.
 *
 * The Exit button calls the platform EXIT endpoint with the operator's platform
 * token (for the audit trail), restores the platform session, and returns to the
 * console — even if the audit call fails, the local session is always restored so
 * the operator is never stuck in the read-only view.
 */
export function ViewAsBanner() {
  const { viewAs, exitViewAs } = useAuth();
  const navigate = useNavigate();
  const [exiting, setExiting] = useState(false);

  if (!viewAs) return null;

  const label = ko.platform.viewAs.banner.label
    .replace("{tenant}", viewAs.actingOrgName)
    .replace("{role}", roleLabel(viewAs.actingRole));

  async function handleExit() {
    setExiting(true);
    // Restore the platform session locally first (the source of truth for the
    // app), then best-effort audit the exit with the operator's platform token.
    const operatorToken = exitViewAs();
    await exitViewAsApi(operatorToken).catch(() => {});
    void navigate("/platform/tenants");
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-900"
    >
      <ShieldAlert size={18} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        disabled={exiting}
        className="inline-flex shrink-0 items-center gap-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-amber-700 disabled:opacity-60"
        onClick={() => {
          void handleExit();
        }}
      >
        <LogOut size={15} aria-hidden="true" />
        {exiting
          ? ko.platform.viewAs.banner.exiting
          : ko.platform.viewAs.banner.exit}
      </button>
    </div>
  );
}

/** Map a role code to its Korean label, falling back to the raw code. */
function roleLabel(role: string): string {
  const roles = ko.platform.viewAs.roles as Record<string, string>;
  return roles[role] ?? role;
}
