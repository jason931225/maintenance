import { useCallback, useEffect, useState } from "react";

import type { PasskeySummary } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { PageError } from "../../components/states/PageError";
import { SkeletonCards } from "../../components/states/Skeleton";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { EnrollHandoffQr } from "./EnrollHandoffQr";
import {
  finishPasskeyRegistration,
  startPasskeyRegistration,
} from "../../auth/webauthn";

type ReadState = "loading" | "idle" | "error";

/**
 * Self-service passkey management for the authenticated user.
 *
 * Lists the caller's own passkeys (registration / last-use timestamps only — the
 * backend never returns secret material), lets them register another passkey
 * reusing the existing enroll ceremony, and revoke one behind an explicit confirm
 * dialog. The backend refuses to delete the user's LAST passkey (409); that state
 * is surfaced gracefully rather than as a generic error.
 */
export function SecurityPanel() {
  const { api } = useAuth();

  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [state, setState] = useState<ReadState>("loading");
  const [adding, setAdding] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [revokingId, setRevokingId] = useState<string | undefined>(undefined);
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setState("loading");
    const response = await api
      .GET("/api/v1/auth/passkeys")
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setPasskeys(response.data);
    setState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function handleAddThisDevice() {
    setError(undefined);
    setFeedback(undefined);
    setShowQr(false);
    setAdding(true);
    try {
      // An already-enrolled user must step up with an existing passkey before a
      // new one is issued; the first passkey (none yet) enrolls without step-up.
      const requireStepUp = passkeys.length > 0;
      const ceremony = await startPasskeyRegistration(
        api,
        {},
        "platform",
        requireStepUp,
      );
      await finishPasskeyRegistration(api, ceremony);
      setFeedback(ko.security.added);
      await load();
    } catch {
      setError(ko.security.addFailed);
    } finally {
      setAdding(false);
    }
  }

  async function handleRevoke(id: string) {
    setError(undefined);
    setFeedback(undefined);
    setRevokingId(id);
    try {
      const response = await api.DELETE("/api/v1/auth/passkeys/{id}", {
        params: { path: { id } },
      });
      if (response.response.status === 409) {
        setError(ko.security.lastPasskey);
        return;
      }
      if (response.error || !response.response.ok) {
        setError(ko.security.revokeFailed);
        return;
      }
      setFeedback(ko.security.revoked);
      await load();
    } catch {
      setError(ko.security.revokeFailed);
    } finally {
      setRevokingId(undefined);
      setConfirmId(undefined);
    }
  }

  const handlePhoneQrCompleted = useCallback(() => {
    setShowQr(false);
    setFeedback(ko.security.added);
    void load();
  }, [load]);

  const isLastPasskey = passkeys.length <= 1;

  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold text-ink">
          {ko.security.title}
        </h2>
        <p className="text-sm text-steel">{ko.security.description}</p>
      </div>

      {state === "error" ? (
        <PageError
          message={ko.security.loadFailed}
          onRetry={() => {
            void load();
          }}
        />
      ) : state === "loading" ? (
        <SkeletonCards count={2} lines={1} />
      ) : (
        <div className="grid gap-3">
          <h3 className="text-sm font-medium text-steel">
            {ko.security.listTitle}
          </h3>
          {passkeys.length === 0 ? (
            <p className="text-sm text-steel">{ko.security.empty}</p>
          ) : (
            <ul className="grid gap-2">
              {passkeys.map((passkey) => (
                <li
                  key={passkey.id}
                  className="flex items-center justify-between gap-4 rounded-md border border-line px-4 py-3"
                >
                  <div className="grid gap-0.5 text-sm">
                    <span className="text-steel">
                      {ko.security.registered}:{" "}
                      {formatTimestamp(passkey.created_at)}
                    </span>
                    <span className="text-steel">
                      {ko.security.lastUsed}:{" "}
                      {passkey.last_used_at
                        ? formatTimestamp(passkey.last_used_at)
                        : ko.security.neverUsed}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={revokingId === passkey.id || isLastPasskey}
                    title={isLastPasskey ? ko.security.lastPasskey : undefined}
                    onClick={() => {
                      setConfirmId(passkey.id);
                    }}
                  >
                    {revokingId === passkey.id
                      ? ko.security.revoking
                      : ko.security.revoke}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {isLastPasskey && passkeys.length === 1 ? (
            <p className="text-sm text-amber-800">{ko.security.lastPasskey}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={adding}
              onClick={() => {
                void handleAddThisDevice();
              }}
            >
              {adding
                ? ko.security.adding
                : `${ko.security.add} (${ko.security.addThisDevice})`}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={adding}
              aria-expanded={showQr}
              onClick={() => {
                setError(undefined);
                setFeedback(undefined);
                setShowQr((open) => !open);
              }}
            >
              {ko.security.addPhoneQr}
            </Button>
          </div>

          {showQr ? (
            <div className="rounded-lg border border-line bg-muted-panel p-4">
              <EnrollHandoffQr
                requireStepUp={passkeys.length > 0}
                initialPasskeyCount={passkeys.length}
                onCompleted={handlePhoneQrCompleted}
              />
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
      {feedback ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-md border border-brand-teal/30 bg-brand-teal/10 px-4 py-2 text-sm font-medium text-brand-teal"
        >
          {feedback}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmId !== undefined}
        title={ko.security.confirmTitle}
        message={ko.security.confirmBody}
        confirmLabel={ko.security.confirmDelete}
        busyLabel={ko.security.revoking}
        cancelLabel={ko.security.cancel}
        destructive
        busy={revokingId !== undefined}
        onConfirm={() => {
          if (confirmId) void handleRevoke(confirmId);
        }}
        onCancel={() => {
          setConfirmId(undefined);
        }}
      />
    </Card>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
