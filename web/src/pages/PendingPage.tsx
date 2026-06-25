import { Clock, UserCircle } from "lucide-react";
import { Link } from "react-router-dom";

import { Card } from "../components/ui/card";
import { ko } from "../i18n/ko";

/**
 * Landing page for a just-signed-up user who holds no role grant yet (an empty
 * roles claim or the placeholder `["MEMBER"]`). The backend default-denies every
 * Feature but Login for this session, so routing them onto /dispatch only yields
 * a 403 + a generic "load failed/retry". Instead we land them here with a clear
 * "account created — awaiting an admin grant" message, the admin-contact
 * guidance, and a link to Profile (the one surface they can use). The redirect to
 * this page is driven by ProtectedRoute.
 */
export function PendingPage() {
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
        </Card>
      </div>
    </div>
  );
}
