import { useCallback, useEffect, useMemo, useState } from "react";

import type { UserSummary } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PolicyGateProvider, type PolicyGate } from "../console/policy";
import {
  CONSOLE_ROLLOUT_ACTIONS,
  ConsoleRolloutToggle,
  deriveConsoleOptInStatus,
  isConsoleRolloutStatus,
  requireConsoleRolloutStatus,
  type ConsoleRolloutApiStatus,
  type ConsoleRolloutStatus as ConsoleRolloutToggleStatus,
} from "../console/rollout";
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

function toConsoleRolloutToggleStatus(
  status: ConsoleRolloutApiStatus,
): ConsoleRolloutToggleStatus {
  return {
    orgEnabled: status.org_enabled && status.org_rollout_enabled,
    killSwitchActive: status.kill_switch_active || status.legacy_kill_switch_enabled,
  };
}

export function ProfilePage() {
  const { api, session } = useAuth();

  const [profile, setProfile] = useState<UserSummary | undefined>(undefined);
  const [state, setState] = useState<ReadState>("loading");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [consoleRollout, setConsoleRollout] = useState<
    ConsoleRolloutApiStatus | undefined
  >(undefined);
  const [consolePending, setConsolePending] = useState(false);
  const { feedback, error, showFeedback, showError, clearFeedback, clearError } =
    useFeedback();
  const consoleRolloutGate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (!consoleRollout) return false;
        return (
          action === CONSOLE_ROLLOUT_ACTIONS.toggleOptIn &&
          consoleRollout.org_enabled &&
          consoleRollout.org_rollout_enabled
        );
      },
    }),
    [consoleRollout],
  );

  const load = useCallback(async () => {
    setState("loading");
    const profileResponse = await api
      .GET("/api/v1/users/me", {})
      .catch(() => undefined);
    if (!profileResponse?.data) {
      setState("error");
      return;
    }
    setProfile(profileResponse.data);
    setDisplayName(profileResponse.data.display_name);
    setPhone(profileResponse.data.phone ?? "");
    setState("idle");

    const rolloutResponse = await api
      .GET("/api/v1/console/rollout", {})
      .catch(() => undefined);
    setConsoleRollout(
      isConsoleRolloutStatus(rolloutResponse?.data) ? rolloutResponse.data : undefined,
    );
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

  async function handleConsoleOptIn(optIn: boolean) {
    if (!consoleRollout) return;
    const previousRollout = consoleRollout;
    clearError();
    setConsolePending(true);
    setConsoleRollout({
      ...consoleRollout,
      user_opted_in: optIn,
      effective_new_console: deriveConsoleOptInStatus(consoleRollout, optIn),
      effective_route: deriveConsoleOptInStatus(consoleRollout, optIn)
        ? "new_console"
        : "legacy",
    });
    try {
      const response = await api.PUT("/api/v1/console/rollout/opt-in", {
        body: { opt_in: optIn },
      });
      if (!response.data) throw new Error("updateConsoleRolloutOptIn failed");
      setConsoleRollout(requireConsoleRolloutStatus(response.data));
    } catch (caught) {
      setConsoleRollout(previousRollout);
      showError(ko.profile.consoleRolloutSaveFailed);
      throw caught;
    } finally {
      setConsolePending(false);
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
                {isPendingMember(
                  profile.roles,
                  session?.group_roles,
                  session?.feature_grants,
                ) ? (
                  <p className="text-sm text-steel">{ko.profile.memberHelp}</p>
                ) : null}
              </div>
            ) : null}

            {consoleRollout ? (
              <PolicyGateProvider gate={consoleRolloutGate}>
                <ConsoleRolloutToggle
                  enabled={consoleRollout.user_opted_in}
                  disabled={
                    consolePending ||
                    consoleRollout.kill_switch_active ||
                    consoleRollout.legacy_kill_switch_enabled
                  }
                  status={toConsoleRolloutToggleStatus(consoleRollout)}
                  onToggle={handleConsoleOptIn}
                />
              </PolicyGateProvider>
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
