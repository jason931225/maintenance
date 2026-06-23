import { useCallback, useEffect, useState } from "react";

import type { UserSummary } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageHeader } from "../components/shell/PageHeader";
import { SecurityPanel } from "../features/auth/SecurityPanel";
import { useAuth } from "../context/auth";
import { isPendingMember } from "../components/shell/nav";
import { roleLabel, teamLabel } from "../features/org/org-format";
import { ko } from "../i18n/ko";
import { useFeedback } from "../lib/useAutoDismiss";

type ReadState = "idle" | "loading" | "error";

export function ProfilePage() {
  const { api } = useAuth();

  const [profile, setProfile] = useState<UserSummary | undefined>(undefined);
  const [state, setState] = useState<ReadState>("loading");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const { feedback, error, showFeedback, showError, clearFeedback, clearError } =
    useFeedback();

  const load = useCallback(async () => {
    setState("loading");
    const response = await api.GET("/api/v1/users/me").catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setProfile(response.data);
    setDisplayName(response.data.display_name);
    setPhone(response.data.phone ?? "");
    setState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function handleSave() {
    clearFeedback();
    if (!displayName.trim()) {
      showError(ko.profile.requiredDisplayName);
      return;
    }
    setPending(true);
    try {
      const response = await api.PATCH("/api/v1/users/me", {
        body: {
          display_name: displayName.trim(),
          phone: phone.trim() ? phone.trim() : null,
        },
      });
      if (!response.data) throw new Error("updateCurrentUser failed");
      setProfile(response.data);
      showFeedback(ko.profile.saved);
    } catch {
      showError(ko.profile.saveFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader title={ko.profile.title} description={ko.profile.description} />

      <div className="max-w-xl">
        {state === "error" ? (
          <PageError
            message={ko.profile.loadFailed}
            onRetry={() => {
              void load();
            }}
          />
        ) : state === "loading" ? (
          <SkeletonCards count={1} lines={4} />
        ) : (
          <Card className="grid gap-4">
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="profile-display-name"
              >
                {ko.profile.displayName}
              </label>
              <Input
                id="profile-display-name"
                value={displayName}
                placeholder={ko.profile.displayNamePlaceholder}
                onChange={(event) => {
                  setDisplayName(event.currentTarget.value);
                }}
              />
            </div>

            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="profile-phone"
              >
                {ko.profile.phone}
              </label>
              <Input
                id="profile-phone"
                value={phone}
                placeholder={ko.profile.phonePlaceholder}
                onChange={(event) => {
                  setPhone(event.currentTarget.value);
                }}
              />
            </div>

            {profile ? (
              <div className="grid gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-steel">
                    {ko.profile.team}:
                  </span>
                  <span className="text-steel">
                    {teamLabel(profile.team)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-steel">
                    {ko.profile.roles}:
                  </span>
                  {profile.roles.length > 0 ? (
                    profile.roles.map((role) => (
                      <Badge key={role}>{roleLabel(role)}</Badge>
                    ))
                  ) : (
                    <span className="text-steel">{ko.users.noRoles}</span>
                  )}
                </div>
                {/* Awaiting a role grant (no role yet, or the placeholder
                    MEMBER): explain why some features are unavailable rather than
                    leaving the user to discover it via a 403. */}
                {isPendingMember(profile.roles) ? (
                  <p className="text-sm text-steel">{ko.profile.memberHelp}</p>
                ) : null}
              </div>
            ) : null}

            <FeedbackBanner kind="error" message={error} onDismiss={clearError} />
            <FeedbackBanner
              kind="success"
              message={feedback}
              onDismiss={clearFeedback}
            />

            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                void handleSave();
              }}
            >
              {pending ? ko.profile.saving : ko.profile.save}
            </Button>
          </Card>
        )}

        <div className="mt-6">
          <SecurityPanel />
        </div>
      </div>
    </>
  );
}
