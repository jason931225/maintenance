import { useId, useState } from "react";

import { PlatformApiError } from "../../api/platform";
import type { PlatformOrg } from "../../api/platform";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ko } from "../../i18n/ko";

/**
 * DESTRUCTIVE force-removal dialog: erase a tenant AND all of its data. This is
 * the most destructive action in the console, so it is deliberately hard to
 * trigger:
 *
 *   1. It is only reachable AFTER the guarded remove was refused (the tenant has
 *      real data), and only this dialog calls `DELETE ...?delete_data=true`.
 *   2. The backend force path is fail-closed by a status rail — it refuses unless
 *      the tenant is ARCHIVED. We mirror that here: if the tenant is not ARCHIVED
 *      we DO NOT offer the force action at all, only the "archive it first"
 *      guidance, so an operator can never even attempt to wipe an active tenant.
 *   3. A double confirmation: the operator must type the tenant's EXACT name into
 *      a labelled input before the (red) "영구 삭제" button enables.
 *
 * A 409 `tenant_active` from the backend (e.g. the tenant was un-archived between
 * the read and the call) surfaces the same "archive first" guidance.
 */
export function ForceRemoveTenantDialog({
  org,
  onConfirm,
  onClose,
}: {
  org: PlatformOrg;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmInputId = useId();
  const [typedName, setTypedName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const copy = ko.platform.tenants.remove.force;
  // The status rail, enforced in the UI: an ARCHIVED tenant is the ONLY one that
  // may be force-removed. For any other status we show the archive-first guidance
  // instead of the destructive action.
  const isArchived = org.status === "ARCHIVED";
  // The double confirmation: the typed name must match the tenant's exact name.
  const nameMatches = typedName === org.name;

  async function handleConfirm() {
    if (!isArchived || !nameMatches) return;
    setError(undefined);
    setPending(true);
    try {
      await onConfirm();
    } catch (cause) {
      // 409 `tenant_active` (not archived) → archive-first guidance; 404 → gone;
      // anything else → generic failure. The dialog stays open on failure.
      if (cause instanceof PlatformApiError && cause.status === 409) {
        setError(copy.notArchived);
      } else if (cause instanceof PlatformApiError && cause.status === 404) {
        setError(copy.notFound);
      } else {
        setError(copy.failed);
      }
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      titleId={titleId}
      describedById={descriptionId}
      closeOnScrimClick={!pending}
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {copy.title}
        </h2>
        <p id={descriptionId} className="text-sm text-steel">
          {copy.description.replace("{name}", org.name)}
        </p>
        <p className="text-sm font-medium text-red-700">{copy.warning}</p>
      </div>

      {isArchived ? (
        <div className="grid gap-1">
          <label
            htmlFor={confirmInputId}
            className="text-sm font-medium text-ink"
          >
            {copy.confirmLabel.replace("{name}", org.name)}
          </label>
          <Input
            id={confirmInputId}
            value={typedName}
            disabled={pending}
            autoComplete="off"
            placeholder={copy.confirmPlaceholder}
            aria-invalid={typedName.length > 0 && !nameMatches}
            aria-describedby={
              typedName.length > 0 && !nameMatches
                ? `${confirmInputId}-mismatch`
                : undefined
            }
            onChange={(event) => {
              setTypedName(event.target.value);
            }}
          />
          {typedName.length > 0 && !nameMatches ? (
            <p
              id={`${confirmInputId}-mismatch`}
              className="text-sm text-red-700"
            >
              {copy.mismatch}
            </p>
          ) : null}
        </div>
      ) : (
        // Not ARCHIVED: do NOT offer the destructive action. Tell the operator to
        // archive (reversible) first.
        <p role="alert" className="text-sm font-medium text-amber-800">
          {copy.notArchived}
        </p>
      )}

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
          {copy.cancel}
        </Button>
        {isArchived ? (
          <Button
            type="button"
            variant="destructive"
            disabled={pending || !nameMatches}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {pending ? copy.applying : copy.apply}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
