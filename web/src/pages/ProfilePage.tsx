import { useCallback, useEffect, useState } from "react";

import type { UserSummary } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/auth";
import { roleLabel, teamLabel } from "../features/org/org-format";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

export function ProfilePage() {
  const { api } = useAuth();

  const [profile, setProfile] = useState<UserSummary | undefined>(undefined);
  const [state, setState] = useState<ReadState>("loading");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

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
    setError(undefined);
    setFeedback(undefined);
    if (!displayName.trim()) {
      setError(ko.profile.requiredDisplayName);
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
      setFeedback(ko.profile.saved);
    } catch {
      setError(ko.profile.saveFailed);
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
          <Card>
            <p role="status" className="text-sm font-medium text-slate-700">
              {ko.common.loading}
            </p>
          </Card>
        ) : (
          <Card className="grid gap-4">
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-slate-700"
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
                className="text-sm font-medium text-slate-700"
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
                  <span className="font-medium text-slate-700">
                    {ko.profile.team}:
                  </span>
                  <span className="text-slate-600">
                    {teamLabel(profile.team)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-700">
                    {ko.profile.roles}:
                  </span>
                  {profile.roles.length > 0 ? (
                    profile.roles.map((role) => (
                      <Badge key={role}>{roleLabel(role)}</Badge>
                    ))
                  ) : (
                    <span className="text-slate-400">{ko.users.noRoles}</span>
                  )}
                </div>
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="text-sm font-medium text-red-700">
                {error}
              </p>
            ) : null}
            {feedback ? (
              <p
                role="status"
                aria-live="polite"
                className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-900"
              >
                {feedback}
              </p>
            ) : null}

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
      </div>
    </>
  );
}
