import { LogOut, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  exitTenantContext as exitTenantContextApi,
  exitViewAs as exitViewAsApi,
} from "../../api/platform";
import { exitGroupTenantContext } from "../../api/groupAdmin";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { cn } from "../../lib/utils";

/**
 * Persistent, unmissable banner shown on EVERY page while a platform operator
 * or group admin is operating inside a tenant context. Renders nothing when not
 * impersonating. Exit restores the source session first, then best-effort audits
 * the stop event so the operator is never stuck in the tenant context.
 */
export function ViewAsBanner() {
  const { viewAs, exitViewAs } = useAuth();
  const navigate = useNavigate();
  const [exiting, setExiting] = useState(false);

  if (!viewAs) return null;

  const activeViewAs = viewAs;
  const isManage = viewAs.mode === "MANAGE";
  const bannerCopy = isManage
    ? ko.platform.tenantContext.banner
    : ko.platform.viewAs.banner;
  const label = bannerCopy.label
    .replace("{tenant}", viewAs.actingOrgName)
    .replace("{role}", roleLabel(viewAs.actingRole));

  async function handleExit() {
    setExiting(true);
    // Restore the source session locally first (the source of truth for the
    // app), then best-effort audit the exit with that source token.
    const operatorToken = exitViewAs();
    if (activeViewAs.source === "GROUP_ADMIN") {
      await exitGroupTenantContext(
        operatorToken,
        activeViewAs.actingOrgId,
      ).catch(() => {});
      void navigate("/settings/group");
      return;
    }

    const exitApi = isManage ? exitTenantContextApi : exitViewAsApi;
    await exitApi(operatorToken).catch(() => {});
    void navigate("/platform/tenants");
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "flex items-center gap-3 border-b px-4 py-2 text-sm font-semibold",
        isManage
          ? "border-brand-teal/40 bg-brand-teal/10 text-brand-teal"
          : "border-amber-300 bg-amber-100 text-amber-900",
      )}
    >
      <ShieldAlert size={18} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        disabled={exiting}
        className={cn(
          "inline-flex shrink-0 items-center gap-2 rounded-md border bg-white px-3 py-1.5 text-sm font-semibold focus-visible:outline-2 disabled:opacity-60",
          isManage
            ? "border-brand-teal/40 text-brand-teal hover:bg-brand-teal/5 focus-visible:outline-brand-teal"
            : "border-amber-400 text-amber-900 hover:bg-amber-50 focus-visible:outline-amber-700",
        )}
        onClick={() => {
          void handleExit();
        }}
      >
        <LogOut size={15} aria-hidden="true" />
        {exiting ? bannerCopy.exiting : bannerCopy.exit}
      </button>
    </div>
  );
}

/** Map a role code to its Korean label, falling back to the raw code. */
function roleLabel(role: string): string {
  const roles = ko.platform.viewAs.roles as Record<string, string>;
  return roles[role] ?? role;
}
