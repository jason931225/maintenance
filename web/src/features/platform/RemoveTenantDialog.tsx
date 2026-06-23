import { useState } from "react";

import { PlatformApiError } from "../../api/platform";
import type { PlatformOrg } from "../../api/platform";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";

/**
 * Confirm dialog for a GUARDED tenant hard-removal. Distinct from
 * {@link StatusChangeDialog} (suspend/archive): removal is IRREVERSIBLE and only
 * permitted for an empty/test tenant. The backend refuses a tenant with real
 * operational data with a 409 ({@link PlatformApiError} `tenant_has_data`); this
 * surfaces that "archive instead" guidance inline rather than a generic failure.
 */
export function RemoveTenantDialog({
  org,
  onConfirm,
  onClose,
}: {
  org: PlatformOrg;
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
    } catch (cause) {
      // A 409 means the tenant has real data: show the "archive instead"
      // guidance. A 404 means it is already gone. Anything else is generic.
      if (cause instanceof PlatformApiError && cause.status === 409) {
        setError(ko.platform.tenants.remove.blocked);
      } else if (cause instanceof PlatformApiError && cause.status === 404) {
        setError(ko.platform.tenants.remove.notFound);
      } else {
        setError(ko.platform.tenants.remove.failed);
      }
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ko.platform.tenants.remove.title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
    >
      <Card className="grid w-full max-w-md gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold text-ink">
            {ko.platform.tenants.remove.title}
          </h2>
          <p className="text-sm text-steel">
            {ko.platform.tenants.remove.confirm.replace("{name}", org.name)}
          </p>
          <p className="text-sm font-medium text-red-700">
            {ko.platform.tenants.remove.warning}
          </p>
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
            {ko.platform.tenants.remove.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {pending
              ? ko.platform.tenants.remove.applying
              : ko.platform.tenants.remove.apply}
          </Button>
        </div>
      </Card>
    </div>
  );
}
