import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../context/auth";
import {
  isNavItemVisible,
  visibleNavItemsForRoles,
  type NavItemKey,
} from "./shell/nav";

interface RequireNavItemRouteProps {
  itemKey: NavItemKey;
  redirectTo?: string;
}

/**
 * Route-level mirror of the role/feature-gated nav registry.
 *
 * The sidebar hiding is only a hint; this guard keeps direct URLs for segmented
 * logistics-maintenance and equipment-sales surfaces from rendering when the
 * same session cannot see the corresponding nav item. Backend APIs still own the
 * authoritative data checks.
 */
export function RequireNavItemRoute({
  itemKey,
  redirectTo,
}: RequireNavItemRouteProps) {
  const { session } = useAuth();
  const visible = isNavItemVisible(
    itemKey,
    session?.roles,
    session?.group_roles,
    session?.feature_grants,
  );

  if (!visible) {
    const fallback =
      redirectTo ??
      visibleNavItemsForRoles(
        session?.roles,
        session?.group_roles,
        session?.feature_grants,
      ).find((item) => item.key !== "profile")?.href ??
      "/settings/profile";
    return <Navigate to={fallback} replace />;
  }

  return <Outlet />;
}
