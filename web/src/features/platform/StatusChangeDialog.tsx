import { useState } from "react";

import type { OrgStatus, PlatformOrg } from "../../api/platform";
import { ConfirmDialog } from "../../components/ui/dialog";
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
    <ConfirmDialog
      open
      title={ko.platform.tenants.statusChange.title}
      message={ko.platform.tenants.statusChange.confirm
        .replace("{name}", org.name)
        .replace("{status}", orgStatusLabel(next))}
      warning={
        next === "ARCHIVED" || next === "SUSPENDED"
          ? ko.platform.tenants.statusChange.warning
          : undefined
      }
      confirmLabel={ko.platform.tenants.statusChange.apply}
      busyLabel={ko.platform.tenants.statusChange.applying}
      cancelLabel={ko.platform.tenants.statusChange.cancel}
      destructive={next === "ARCHIVED"}
      busy={pending}
      error={error}
      onConfirm={() => {
        void handleConfirm();
      }}
      onCancel={onClose}
    />
  );
}
