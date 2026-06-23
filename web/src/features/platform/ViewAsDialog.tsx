import { useState } from "react";

import type { PlatformOrg, ViewAsRole } from "../../api/platform";
import { PlatformApiError } from "../../api/platform";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";

/** The roles a platform operator may impersonate, highest-privilege first. */
const VIEW_AS_ROLES: ViewAsRole[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
];

/**
 * Role-picker dialog for starting a read-only "view as" session against one
 * tenant. `onConfirm` is given the chosen role; the page mints the impersonation
 * token and switches the app into the tenant view.
 */
export function ViewAsDialog({
  org,
  onConfirm,
  onClose,
}: {
  org: PlatformOrg;
  onConfirm: (role: ViewAsRole) => Promise<void>;
  onClose: () => void;
}) {
  const [role, setRole] = useState<ViewAsRole>("ADMIN");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleConfirm() {
    setError(undefined);
    setPending(true);
    try {
      await onConfirm(role);
    } catch (err) {
      // A 409 means the tenant is not ACTIVE; surface the specific guidance,
      // otherwise the generic failure message.
      setError(
        err instanceof PlatformApiError && err.status === 409
          ? ko.platform.viewAs.dialog.notActive
          : ko.platform.viewAs.dialog.failed,
      );
      setPending(false);
    }
  }

  const roleLabels = ko.platform.viewAs.roles as Record<string, string>;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ko.platform.viewAs.dialog.title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
    >
      <Card className="grid w-full max-w-md gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold text-ink">
            {ko.platform.viewAs.dialog.title}
          </h2>
          <p className="text-sm text-steel">
            {ko.platform.viewAs.dialog.description.replace("{name}", org.name)}
          </p>
          <p className="text-sm font-medium text-amber-800">
            {ko.platform.viewAs.dialog.warning}
          </p>
        </div>

        <label className="grid gap-1 text-sm font-medium text-ink">
          {ko.platform.viewAs.dialog.roleLabel}
          <select
            className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-ink"
            value={role}
            disabled={pending}
            onChange={(event) => {
              setRole(event.target.value as ViewAsRole);
            }}
          >
            {VIEW_AS_ROLES.map((code) => (
              <option key={code} value={code}>
                {roleLabels[code] ?? code}
              </option>
            ))}
          </select>
        </label>

        {error ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={onClose}
          >
            {ko.platform.viewAs.dialog.cancel}
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={pending}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {pending
              ? ko.platform.viewAs.dialog.starting
              : ko.platform.viewAs.dialog.start}
          </Button>
        </div>
      </Card>
    </div>
  );
}
