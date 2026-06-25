import { useState } from "react";

import { PlatformApiError } from "../../api/platform";
import type { PlatformOrg } from "../../api/platform";
import { ConfirmDialog } from "../../components/ui/dialog";
import { ko } from "../../i18n/ko";

/**
 * Confirm dialog for a GUARDED tenant hard-removal. Distinct from
 * {@link StatusChangeDialog} (suspend/archive): removal is IRREVERSIBLE and only
 * permitted for an empty/test tenant. The backend refuses a tenant with real
 * operational data with a 409 ({@link PlatformApiError} `tenant_has_data`); this
 * surfaces that "archive instead" guidance inline rather than a generic failure.
 *
 * When the guarded remove IS blocked by real data, this also reveals an opt-in
 * DESTRUCTIVE escape — "데이터까지 영구 삭제" — that hands off to
 * {@link ForceRemoveTenantDialog} (the force path with a double confirmation).
 * The reveal only appears after the guarded attempt is refused, so the force
 * action is never the first thing an operator sees.
 */
export function RemoveTenantDialog({
  org,
  onConfirm,
  onForceRequested,
  onClose,
}: {
  org: PlatformOrg;
  onConfirm: () => Promise<void>;
  /** Switch to the destructive force-removal flow (only offered when blocked). */
  onForceRequested: () => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // True once the guarded remove was refused because the tenant has real data:
  // only then do we reveal the destructive force option.
  const [blockedByData, setBlockedByData] = useState(false);

  async function handleConfirm() {
    setError(undefined);
    setPending(true);
    try {
      await onConfirm();
    } catch (cause) {
      // A 409 means the tenant has real data: show the "archive instead"
      // guidance AND reveal the force escape. A 404 means it is already gone.
      // Anything else is generic.
      if (cause instanceof PlatformApiError && cause.status === 409) {
        setError(ko.platform.tenants.remove.blocked);
        setBlockedByData(true);
      } else if (cause instanceof PlatformApiError && cause.status === 404) {
        setError(ko.platform.tenants.remove.notFound);
      } else {
        setError(ko.platform.tenants.remove.failed);
      }
      setPending(false);
    }
  }

  return (
    <ConfirmDialog
      open
      title={ko.platform.tenants.remove.title}
      message={ko.platform.tenants.remove.confirm.replace("{name}", org.name)}
      warning={ko.platform.tenants.remove.warning}
      confirmLabel={ko.platform.tenants.remove.apply}
      busyLabel={ko.platform.tenants.remove.applying}
      cancelLabel={ko.platform.tenants.remove.cancel}
      destructive
      busy={pending}
      error={
        error ? (
          <>
            {error}
            {blockedByData ? (
              <>
                {" "}
                <button
                  type="button"
                  className="font-semibold text-red-700 underline underline-offset-2"
                  onClick={onForceRequested}
                >
                  {ko.platform.tenants.remove.force.reveal}
                </button>
              </>
            ) : null}
          </>
        ) : undefined
      }
      onConfirm={() => {
        void handleConfirm();
      }}
      onCancel={onClose}
    />
  );
}
