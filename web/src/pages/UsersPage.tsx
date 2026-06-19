import { KeyRound, Pencil, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  BranchSummary,
  CreateUserRequest,
  Team,
  UpdateUserRequest,
  UserSummary,
} from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { useAuth } from "../context/auth";
import {
  ASSIGNABLE_ROLES,
  roleLabel,
  teamLabel,
  TEAMS,
} from "../features/org/org-format";
import { issueAdminOtp } from "../auth/webauthn";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

interface IssuedOtp {
  otp: string;
  expiresAt: string;
}

export function UsersPage() {
  const { api } = useAuth();

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [listState, setListState] = useState<ReadState>("loading");
  const [includeInactive, setIncludeInactive] = useState(false);

  // `undefined` => create mode; a user => edit mode.
  const [editing, setEditing] = useState<UserSummary | undefined>(undefined);
  // The OTP target user, when the issue dialog is open.
  const [otpUser, setOtpUser] = useState<UserSummary | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  // Track the most-recently created user so we can nudge the admin to issue OTP.
  const [newUserId, setNewUserId] = useState<string | undefined>(undefined);

  const loadUsers = useCallback(async () => {
    setListState("loading");
    const response = await api
      .GET("/api/v1/users", {
        params: { query: { include_inactive: includeInactive } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setListState("error");
      return;
    }
    setUsers(response.data);
    setListState("idle");
  }, [api, includeInactive]);

  const loadBranches = useCallback(async () => {
    const response = await api.GET("/api/v1/branches").catch(() => undefined);
    if (response?.data) setBranches(response.data);
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadUsers);
  }, [loadUsers]);

  useEffect(() => {
    void Promise.resolve().then(loadBranches);
  }, [loadBranches]);

  const branchName = useCallback(
    (id: string) => branches.find((b) => b.id === id)?.name ?? id,
    [branches],
  );

  async function createUser(body: CreateUserRequest): Promise<void> {
    const response = await api.POST("/api/v1/users", { body });
    if (!response.data) throw new Error("createUser failed");
    setNewUserId(response.data.id);
    setFeedback(ko.users.form.created);
    await loadUsers();
  }

  async function updateUser(
    id: string,
    body: UpdateUserRequest,
  ): Promise<void> {
    const response = await api.PATCH("/api/v1/users/{id}", {
      params: { path: { id } },
      body,
    });
    if (!response.data) throw new Error("updateUser failed");
    setFeedback(ko.users.form.saved);
    setEditing(undefined);
    await loadUsers();
  }

  async function deactivateUser(user: UserSummary): Promise<void> {
    if (!window.confirm(ko.users.deactivateConfirm)) return;
    const response = await api
      .POST("/api/v1/users/{id}/deactivate", {
        params: { path: { id: user.id } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setFeedback(ko.users.deactivateFailed);
      return;
    }
    setFeedback(ko.users.deactivated);
    await loadUsers();
  }

  return (
    <>
      <PageHeader
        title={ko.users.title}
        description={ko.users.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadUsers();
            }}
            isLoading={listState === "loading"}
          />
        }
      />

      {feedback ? (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-900"
        >
          {feedback}
        </p>
      ) : null}

      {newUserId ? (
        <p
          role="alert"
          aria-live="polite"
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900"
        >
          {ko.users.noCredentialPrompt}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="size-4 rounded border-slate-300"
              checked={includeInactive}
              onChange={(event) => {
                setIncludeInactive(event.currentTarget.checked);
              }}
            />
            {ko.users.includeInactive}
          </label>

          {listState === "error" ? (
            <PageError
              message={ko.users.loadFailed}
              onRetry={() => {
                void loadUsers();
              }}
            />
          ) : (
            <UserTable
              users={users}
              isLoading={listState === "loading"}
              newUserId={newUserId}
              branchName={branchName}
              onEdit={(user) => {
                setFeedback(undefined);
                setNewUserId(undefined);
                setEditing(user);
              }}
              onDeactivate={(user) => {
                setFeedback(undefined);
                setNewUserId(undefined);
                void deactivateUser(user);
              }}
              onIssueOtp={(user) => {
                setFeedback(undefined);
                if (user.id === newUserId) setNewUserId(undefined);
                setOtpUser(user);
              }}
            />
          )}
        </div>

        <div className="grid gap-4">
          <UserForm
            key={editing?.id ?? "create"}
            editing={editing}
            branches={branches}
            onSubmit={async (body) => {
              if (editing) {
                await updateUser(editing.id, body);
              } else {
                await createUser(body as CreateUserRequest);
              }
            }}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </div>
      </div>

      {otpUser ? (
        <IssueOtpDialog
          user={otpUser}
          branchName={branchName}
          onClose={() => {
            setOtpUser(undefined);
          }}
        />
      ) : null}
    </>
  );
}

function UserTable({
  users,
  isLoading,
  newUserId,
  branchName,
  onEdit,
  onDeactivate,
  onIssueOtp,
}: {
  users: UserSummary[];
  isLoading: boolean;
  newUserId: string | undefined;
  branchName: (id: string) => string;
  onEdit: (user: UserSummary) => void;
  onDeactivate: (user: UserSummary) => void;
  onIssueOtp: (user: UserSummary) => void;
}) {
  if (isLoading) {
    return (
      <Card>
        <p role="status" className="text-sm font-medium text-slate-700">
          {ko.common.loading}
        </p>
      </Card>
    );
  }

  if (users.length === 0) {
    return <PageEmpty message={ko.users.empty} />;
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <th className="px-4 py-3">{ko.users.columns.name}</th>
            <th className="px-4 py-3">{ko.users.columns.phone}</th>
            <th className="px-4 py-3">{ko.users.columns.team}</th>
            <th className="px-4 py-3">{ko.users.columns.roles}</th>
            <th className="px-4 py-3">{ko.users.columns.branches}</th>
            <th className="px-4 py-3">{ko.users.columns.active}</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr
              key={user.id}
              className="border-b border-slate-100 last:border-0 align-top"
            >
              <td className="px-4 py-3 font-medium text-slate-950">
                {user.display_name}
              </td>
              <td className="px-4 py-3 text-slate-700">
                {user.phone ?? ko.common.notSet}
              </td>
              <td className="px-4 py-3 text-slate-700">
                {teamLabel(user.team)}
              </td>
              <td className="px-4 py-3">
                {user.roles.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {user.roles.map((role) => (
                      <Badge key={role}>{roleLabel(role)}</Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-slate-400">{ko.users.noRoles}</span>
                )}
              </td>
              <td className="px-4 py-3">
                {user.branch_ids.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {user.branch_ids.map((id) => (
                      <Badge key={id}>{branchName(id)}</Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-slate-400">{ko.users.noBranches}</span>
                )}
              </td>
              <td className="px-4 py-3">
                {user.is_active ? (
                  <Badge className="border-emerald-300 text-emerald-800">
                    {ko.users.active}
                  </Badge>
                ) : (
                  <Badge className="border-slate-300 text-slate-500">
                    {ko.users.inactive}
                  </Badge>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {user.id === newUserId ? (
                    <Badge className="border-amber-300 bg-amber-50 text-amber-800">
                      {ko.users.noCredentialBadge}
                    </Badge>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onEdit(user);
                    }}
                  >
                    <Pencil aria-hidden="true" size={14} />
                    {ko.users.edit}
                  </Button>
                  <Button
                    type="button"
                    variant={user.id === newUserId ? "default" : "secondary"}
                    size="sm"
                    onClick={() => {
                      onIssueOtp(user);
                    }}
                  >
                    <KeyRound aria-hidden="true" size={14} />
                    {ko.users.otp.issue}
                  </Button>
                  {user.is_active ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        onDeactivate(user);
                      }}
                    >
                      {ko.users.deactivate}
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function UserForm({
  editing,
  branches,
  onSubmit,
  onCancel,
}: {
  editing: UserSummary | undefined;
  branches: BranchSummary[];
  onSubmit: (body: CreateUserRequest | UpdateUserRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(editing?.display_name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [team, setTeam] = useState<Team>(editing?.team ?? "MAINTENANCE");
  const [roles, setRoles] = useState<string[]>(editing?.roles ?? []);
  const [branchIds, setBranchIds] = useState<string[]>(
    editing?.branch_ids ?? [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function toggle(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((v) => v !== value)
      : [...list, value];
  }

  async function handleSubmit() {
    setError(undefined);
    if (!displayName.trim()) {
      setError(ko.users.form.requiredDisplayName);
      return;
    }
    if (roles.length === 0) {
      setError(ko.users.form.requiredRole);
      return;
    }
    if (branchIds.length === 0) {
      setError(ko.users.form.requiredBranch);
      return;
    }
    setPending(true);
    try {
      await onSubmit({
        display_name: displayName.trim(),
        phone: phone.trim() ? phone.trim() : null,
        team,
        roles,
        branch_ids: branchIds,
      });
    } catch {
      setError(editing ? ko.users.form.saveFailed : ko.users.form.createFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="grid gap-4">
      <h2 className="text-lg font-semibold text-slate-950">
        {editing ? ko.users.editTitle : ko.users.createTitle}
      </h2>

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-slate-700"
          htmlFor="user-display-name"
        >
          {ko.users.form.displayName}
        </label>
        <Input
          id="user-display-name"
          value={displayName}
          placeholder={ko.users.form.displayNamePlaceholder}
          onChange={(event) => {
            setDisplayName(event.currentTarget.value);
          }}
        />
      </div>

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-slate-700"
          htmlFor="user-phone"
        >
          {ko.users.form.phone}
        </label>
        <Input
          id="user-phone"
          value={phone}
          placeholder={ko.users.form.phonePlaceholder}
          onChange={(event) => {
            setPhone(event.currentTarget.value);
          }}
        />
      </div>

      <div className="grid gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="user-team">
          {ko.users.form.team}
        </label>
        <Select
          id="user-team"
          value={team}
          onChange={(event) => {
            setTeam(event.currentTarget.value as Team);
          }}
        >
          {TEAMS.map((value) => (
            <option key={value} value={value}>
              {teamLabel(value)}
            </option>
          ))}
        </Select>
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium text-slate-700">
          {ko.users.form.roles}
        </legend>
        <div className="grid gap-1">
          {ASSIGNABLE_ROLES.map((role) => (
            <label
              key={role}
              className="flex items-center gap-2 text-sm text-slate-700"
            >
              <input
                type="checkbox"
                className="size-4 rounded border-slate-300"
                checked={roles.includes(role)}
                onChange={() => {
                  setRoles((prev) => toggle(prev, role));
                }}
              />
              {roleLabel(role)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium text-slate-700">
          {ko.users.form.branches}
        </legend>
        {branches.length === 0 ? (
          <p className="text-sm text-slate-500">
            {ko.users.form.noBranchOptions}
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-500">
              {ko.users.form.branchesHint}
            </p>
            <div className="grid gap-1">
              {branches.map((branch) => (
                <label
                  key={branch.id}
                  className="flex items-center gap-2 text-sm text-slate-700"
                >
                  <input
                    type="checkbox"
                    className="size-4 rounded border-slate-300"
                    checked={branchIds.includes(branch.id)}
                    onChange={() => {
                      setBranchIds((prev) => toggle(prev, branch.id));
                    }}
                  />
                  {branch.name}
                </label>
              ))}
            </div>
          </>
        )}
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            void handleSubmit();
          }}
        >
          {editing ? null : <UserPlus aria-hidden="true" size={18} />}
          {editing
            ? pending
              ? ko.users.form.saving
              : ko.users.form.save
            : pending
              ? ko.users.form.creating
              : ko.users.form.create}
        </Button>
        {editing ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={onCancel}
          >
            {ko.users.form.cancel}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function IssueOtpDialog({
  user,
  branchName,
  onClose,
}: {
  user: UserSummary;
  branchName: (id: string) => string;
  onClose: () => void;
}) {
  const { api } = useAuth();
  const branchId = user.branch_ids[0];
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<IssuedOtp | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  async function handleIssue() {
    if (!branchId) return;
    setError(undefined);
    setCopied(false);
    setPending(true);
    try {
      const result = await issueAdminOtp(api, {
        user_id: user.id,
        branch_id: branchId,
      });
      setIssued({ otp: result.otp, expiresAt: result.expires_at });
    } catch {
      setError(ko.users.otp.failed);
    } finally {
      setPending(false);
    }
  }

  async function handleCopy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ko.users.otp.title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 p-4"
    >
      <Card className="grid w-full max-w-md gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold text-slate-950">
            {ko.users.otp.title}
          </h2>
          <p className="text-sm text-slate-600">{ko.users.otp.description}</p>
          <p className="text-sm font-medium text-slate-800">
            {user.display_name}
          </p>
        </div>

        {branchId ? (
          <p className="text-sm text-slate-600">
            {ko.users.otp.branchLabel}: {branchName(branchId)}
          </p>
        ) : (
          <p role="alert" className="text-sm font-medium text-red-700">
            {ko.users.otp.noBranch}
          </p>
        )}

        {issued ? (
          <div className="grid gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-4">
            <span className="text-sm font-medium text-emerald-900">
              {ko.users.otp.issued}
            </span>
            <div className="flex items-center gap-2">
              <code className="rounded bg-white px-3 py-2 text-lg font-semibold tracking-widest text-slate-950">
                {issued.otp}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  void handleCopy(issued.otp);
                }}
              >
                {copied ? ko.users.otp.copied : ko.users.otp.copy}
              </Button>
            </div>
            <span role="status" aria-live="polite" className="sr-only">
              {copied ? ko.users.otp.copied : ""}
            </span>
            <span className="text-sm text-emerald-900">
              {ko.users.otp.expiresAt}:{" "}
              {new Date(issued.expiresAt).toLocaleString("ko-KR", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          {!issued && branchId ? (
            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                void handleIssue();
              }}
            >
              <KeyRound aria-hidden="true" size={18} />
              {pending ? ko.users.otp.issuing : ko.users.otp.issue}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            {ko.users.otp.close}
          </Button>
        </div>
      </Card>
    </div>
  );
}
