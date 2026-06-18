import { useState } from "react";

import type { OrgStatus, PlatformOrg } from "../../api/platform";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { orgStatusLabel } from "./org-status";

/**
 * Confirm dialog for a tenant status change. The change is consequential
 * (suspending cuts off a tenant; archiving retires it), so it is gated behind an
 * explicit confirm rather than fired inline.
 */
export function StatusChangeDialog({
  org,
  next,
  onConfirm,
  onClose,
}: {
  org: PlatformOrg;
  next: OrgStatus;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleConfirm() {
    setError(undefined);
    setPending(true);
    try {
      await onConfirm();
    } catch {
      setError(ko.platform.tenants.statusChange.failed);
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ko.platform.tenants.statusChange.title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 p-4"
    >
      <Card className="grid w-full max-w-md gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold text-slate-950">
            {ko.platform.tenants.statusChange.title}
          </h2>
          <p className="text-sm text-slate-600">
            {ko.platform.tenants.statusChange.confirm
              .replace("{name}", org.name)
              .replace("{status}", orgStatusLabel(next))}
          </p>
          {next === "ARCHIVED" || next === "SUSPENDED" ? (
            <p className="text-sm font-medium text-amber-800">
              {ko.platform.tenants.statusChange.warning}
            </p>
          ) : null}
        </div>

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
            {ko.platform.tenants.statusChange.cancel}
          </Button>
          <Button
            type="button"
            variant={next === "ARCHIVED" ? "destructive" : "default"}
            disabled={pending}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {pending
              ? ko.platform.tenants.statusChange.applying
              : ko.platform.tenants.statusChange.apply}
          </Button>
        </div>
      </Card>
    </div>
  );
}
