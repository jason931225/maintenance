import { CalendarClock, Clock, RefreshCw, UserCircle } from "lucide-react";
import { useState } from "react";
import { Link, Navigate } from "react-router";

import {
  hasGrantedConsoleAccess,
  isGrantedConsoleNavItem,
  visibleNavItemsForRoles,
} from "../components/shell/nav";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

/**
 * Landing page for a just-signed-up user who holds no console grant yet (an empty
 * roles claim or the placeholder `["MEMBER"]`, with no group-admin or runtime
 * feature grants). The backend default-denies every Feature but Login for this
 * session, so routing them onto /dispatch only yields a 403 + a generic
 * "account created — awaiting an admin grant" message, the admin-contact
 * guidance, and links to Profile and principal-bound My Attendance self-service.
 * The redirect to this page is driven by ProtectedRoute.
 */
export function PendingPage() {
  const { refresh, session } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const pending = !hasGrantedConsoleAccess(
    session?.roles,
    session?.group_roles,
    session?.feature_grants,
  );

  if (!pending) {
    const destination =
      visibleNavItemsForRoles(
        session?.roles,
        session?.group_roles,
        session?.feature_grants,
      ).find(isGrantedConsoleNavItem)?.href ?? "/settings/profile";
    return <Navigate to={destination} replace />;
  }

  async function checkAccess() {
    setRefreshFailed(false);
    setRefreshing(true);
    try {
      await refresh();
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted-panel px-4 py-12">
      <div className="grid w-full max-w-md gap-6">
        <Card className="grid gap-5 p-6">
          <div className="flex items-start gap-3">
            <Clock
              aria-hidden="true"
              size={24}
              className="mt-0.5 shrink-0 text-brand-teal"
            />
            <div className="grid gap-1">
              <h1 className="text-xl font-semibold text-ink">
                {ko.pending.title}
              </h1>
              <p className="text-sm text-steel">{ko.pending.message}</p>
            </div>
          </div>

          <p className="rounded-lg border border-line bg-muted-panel p-3 text-sm text-steel">
            {ko.pending.contactGuidance}
          </p>

          <Link
            to="/settings/profile"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-line bg-white px-4 py-2 text-sm font-medium text-steel transition hover:border-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <UserCircle size={18} aria-hidden="true" />
            {ko.pending.profileLink}
          </Link>
          <Link
            to="/attendance"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-line bg-white px-4 py-2 text-sm font-medium text-steel transition hover:border-steel hover:bg-muted-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <CalendarClock size={18} aria-hidden="true" />
            {ko.nav["my-attendance"]}
          </Link>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void checkAccess();
            }}
            disabled={refreshing}
          >
            <RefreshCw size={18} aria-hidden="true" />
            {refreshing ? ko.pending.checkingAccess : ko.pending.checkAccess}
          </Button>

          {refreshFailed ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {ko.pending.refreshFailed}
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
