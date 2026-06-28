import {
  KeyRound,
  MoreHorizontal,
  Pencil,
  RotateCcwKey,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { ConfirmDialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageHeader } from "../components/shell/PageHeader";
import { LoadMoreButton } from "../components/shell/LoadMoreButton";
import { RefreshButton } from "../components/shell/RefreshButton";
import { useAuth } from "../context/auth";
import {
  ASSIGNABLE_ROLES,
  roleLabel,
  teamLabel,
  TEAMS,
} from "../features/org/org-format";
import { issueAdminOtp, resetUserCredentials } from "../auth/webauthn";
import { ko } from "../i18n/ko";
import {
  SUCCESS_DISMISS_MS,
  useAutoDismiss,
} from "../lib/useAutoDismiss";
import { formatListCount, safeLabel } from "../lib/utils";

type ReadState = "idle" | "loading" | "error";
const ELEVATED_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE"]);

// The /api/v1/users endpoint now returns a UserPage with `total` + `offset`, so
// the roster pages properly: fetch one page at a time and append via offset, and
// show the honest unpaged total from the API.
const USERS_PAGE_LIMIT = 200;

interface IssuedOtp {
  otp: string;
  expiresAt: string;
}

export function UsersPage() {
  const { api } = useAuth();

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [userTotal, setUserTotal] = useState<number>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [listState, setListState] = useState<ReadState>("loading");
  const [includeInactive, setIncludeInactive] = useState(false);

  // The editor slide-over: closed, "create" mode, or a user in "edit" mode.
  const [editorMode, setEditorMode] = useState<"closed" | "create" | "edit">(
    "closed",
  );
  const [editing, setEditing] = useState<UserSummary | undefined>(undefined);
  // The OTP target user, when the issue dialog is open.
  const [otpUser, setOtpUser] = useState<UserSummary | undefined>(undefined);
  // The credential-reset target user, when the reset dialog is open.
  const [resetUser, setResetUser] = useState<UserSummary | undefined>(
    undefined,
  );
  // The deactivation target user, when the confirm dialog is open, plus the
  // in-flight flag that drives the dialog's busy state.
  const [deactivateTarget, setDeactivateTarget] = useState<
    UserSummary | undefined
  >(undefined);
  const [deactivating, setDeactivating] = useState(false);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const clearFeedback = useCallback(() => {
    setFeedback(undefined);
  }, []);
  useAutoDismiss(feedback, clearFeedback, SUCCESS_DISMISS_MS);
  // Track the most-recently created user so we can nudge the admin to issue OTP.
  const [newUserId, setNewUserId] = useState<string | undefined>(undefined);

  const loadUsers = useCallback(async () => {
    setListState("loading");
    const response = await api
      .GET("/api/v1/users", {
        params: {
          query: {
            include_inactive: includeInactive,
            limit: USERS_PAGE_LIMIT,
            offset: 0,
          },
        },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setListState("error");
      return;
    }
    setUsers(response.data.items);
    setUserTotal(response.data.total);
    setListState("idle");
  }, [api, includeInactive]);

  const loadMoreUsers = useCallback(async () => {
    setLoadingMore(true);
    try {
      const response = await api
        .GET("/api/v1/users", {
          params: {
            query: {
              include_inactive: includeInactive,
              limit: USERS_PAGE_LIMIT,
              offset: users.length,
            },
          },
        })
        .catch(() => undefined);
      if (response?.data) {
        const next = response.data;
        setUsers((current) => [...current, ...next.items]);
        setUserTotal(next.total);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [api, includeInactive, users.length]);

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
    // Never surface the raw branch UUID when the branch list is missing the row
    // (e.g. a separate branch-fetch failure, or a branch outside the caller's
    // scope); fall back to a human label instead.
    (id: string) => safeLabel(branches.find((b) => b.id === id)?.name),
    [branches],
  );

  function closeEditor() {
    setEditorMode("closed");
    setEditing(undefined);
  }

  async function createUser(body: CreateUserRequest): Promise<void> {
    const response = await api.POST("/api/v1/users", { body });
    if (!response.data) throw new Error("createUser failed");
    setNewUserId(response.data.id);
    setFeedback(ko.users.form.created);
    closeEditor();
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
    closeEditor();
    await loadUsers();
  }

  async function deactivateUser(user: UserSummary): Promise<void> {
    setDeactivating(true);
    const response = await api
      .POST("/api/v1/users/{id}/deactivate", {
        params: { path: { id: user.id } },
      })
      .catch(() => undefined);
    setDeactivating(false);
    setDeactivateTarget(undefined);
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
          <div className="flex items-center gap-2">
            <RefreshButton
              onClick={() => {
                void loadUsers();
              }}
              isLoading={listState === "loading"}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setFeedback(undefined);
                setNewUserId(undefined);
                setEditing(undefined);
                setEditorMode("create");
              }}
            >
              <UserPlus aria-hidden="true" size={16} />
              {ko.users.create}
            </Button>
          </div>
        }
      />

      <FeedbackBanner
        kind="success"
        message={feedback}
        onDismiss={clearFeedback}
        className="mb-4"
      />

      {newUserId ? (
        <p
          role="alert"
          aria-live="polite"
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900"
        >
          {ko.users.noCredentialPrompt}
        </p>
      ) : null}

      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm text-steel">
            <input
              type="checkbox"
              className="size-4 rounded border-line"
              checked={includeInactive}
              onChange={(event) => {
                setIncludeInactive(event.currentTarget.checked);
              }}
            />
            {ko.users.includeInactive}
          </label>
          {listState === "idle" && users.length > 0 ? (
            <Badge>
              {formatListCount(userTotal ?? users.length)}
            </Badge>
          ) : null}
        </div>

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
              setEditorMode("edit");
            }}
            onDeactivate={(user) => {
              setFeedback(undefined);
              setNewUserId(undefined);
              setDeactivateTarget(user);
            }}
            onIssueOtp={(user) => {
              setFeedback(undefined);
              if (user.id === newUserId) setNewUserId(undefined);
              setOtpUser(user);
            }}
            onResetCredentials={(user) => {
              setFeedback(undefined);
              if (user.id === newUserId) setNewUserId(undefined);
              setResetUser(user);
            }}
          />
        )}
        {listState === "idle" &&
        userTotal !== undefined &&
        users.length < userTotal ? (
          <LoadMoreButton
            onClick={() => {
              void loadMoreUsers();
            }}
            isLoading={loadingMore}
            loaded={users.length}
            total={userTotal}
          />
        ) : null}
      </div>

      {editorMode !== "closed" ? (
        <UserFormDrawer
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
          onClose={closeEditor}
        />
      ) : null}

      {otpUser ? (
        <IssueOtpDialog
          user={otpUser}
          branchName={branchName}
          onClose={() => {
            setOtpUser(undefined);
          }}
        />
      ) : null}

      {resetUser ? (
        <ResetCredentialsDialog
          user={resetUser}
          onClose={() => {
            setResetUser(undefined);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deactivateTarget !== undefined}
        title={ko.users.deactivateTitle}
        message={
          deactivateTarget
            ? ko.users.deactivateConfirm.replace(
                "{name}",
                deactivateTarget.display_name,
              )
            : ""
        }
        confirmLabel={ko.users.deactivate}
        busyLabel={ko.users.deactivating}
        destructive
        busy={deactivating}
        onConfirm={() => {
          if (deactivateTarget) void deactivateUser(deactivateTarget);
        }}
        onCancel={() => {
          setDeactivateTarget(undefined);
        }}
      />
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
  onResetCredentials,
}: {
  users: UserSummary[];
  isLoading: boolean;
  newUserId: string | undefined;
  branchName: (id: string) => string;
  onEdit: (user: UserSummary) => void;
  onDeactivate: (user: UserSummary) => void;
  onIssueOtp: (user: UserSummary) => void;
  onResetCredentials: (user: UserSummary) => void;
}) {
  // Only show the skeleton on the first load; a refetch keeps the existing rows
  // visible (stale-while-revalidate) instead of flashing back to placeholders.
  if (isLoading && users.length === 0) {
    return <SkeletonTable rows={5} cols={7} />;
  }

  if (users.length === 0) {
    return <PageEmpty message={ko.users.empty} />;
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold uppercase tracking-wider text-steel">
            <th className="px-4 py-3">{ko.users.columns.name}</th>
            <th className="px-4 py-3">{ko.users.columns.phone}</th>
            <th className="px-4 py-3">{ko.users.columns.team}</th>
            <th className="px-4 py-3">{ko.users.columns.roles}</th>
            <th className="px-4 py-3">{ko.users.columns.branches}</th>
            <th className="px-4 py-3">{ko.users.columns.active}</th>
            <th className="px-4 py-3 text-right">{ko.common.actions}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr
              key={user.id}
              className="border-b border-line align-top last:border-0"
            >
              <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">
                {user.display_name}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-steel">
                {user.phone ?? ko.common.notSet}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-steel">
                {teamLabel(user.team)}
              </td>
              <td className="px-4 py-3">
                {user.roles.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {user.roles.map((role) => (
                      <Badge key={role} className="whitespace-nowrap">
                        {roleLabel(role)}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-steel">{ko.users.noRoles}</span>
                )}
              </td>
              <td className="px-4 py-3">
                {user.branch_ids.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {user.branch_ids.map((id) => (
                      <Badge key={id} className="whitespace-nowrap">
                        {branchName(id)}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-steel">{ko.users.noBranches}</span>
                )}
              </td>
              <td className="px-4 py-3">
                {user.account_status === "ACTIVE" ? (
                  <Badge className="whitespace-nowrap border-brand-teal/30 text-brand-teal">
                    {ko.users.active}
                  </Badge>
                ) : user.account_status === "PENDING_SETUP" ? (
                  <Badge
                    className="whitespace-nowrap border-amber-300 bg-amber-50 text-amber-800"
                    title={ko.users.pendingSetupHint}
                  >
                    {ko.users.pendingSetup}
                  </Badge>
                ) : (
                  <Badge className="whitespace-nowrap border-line text-steel">
                    {ko.users.inactive}
                  </Badge>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-2">
                  {user.id === newUserId ? (
                    <Badge className="whitespace-nowrap border-amber-300 bg-amber-50 text-amber-800">
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
                  <RowActionsMenu
                    user={user}
                    isNewUser={user.id === newUserId}
                    onIssueOtp={onIssueOtp}
                    onResetCredentials={onResetCredentials}
                    onDeactivate={onDeactivate}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Overflow menu for the less-common per-row actions (issue OTP, reset
 * credentials, deactivate). Keeps the row to two visible controls so a
 * narrowed table never wraps the action cell. Closes on Escape or an
 * outside click; the trigger reflects open state for assistive tech.
 */
function RowActionsMenu({
  user,
  isNewUser,
  onIssueOtp,
  onResetCredentials,
  onDeactivate,
}: {
  user: UserSummary;
  isNewUser: boolean;
  onIssueOtp: (user: UserSummary) => void;
  onResetCredentials: (user: UserSummary) => void;
  onDeactivate: (user: UserSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${user.display_name} ${ko.users.moreActionsFor}`}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        <MoreHorizontal aria-hidden="true" size={14} />
        {ko.users.moreActions}
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 flex w-56 flex-col gap-1 rounded-md border border-line bg-white p-1 shadow-lg"
        >
          <Button
            role="menuitem"
            type="button"
            variant={isNewUser ? "default" : "ghost"}
            size="sm"
            className="w-full justify-start"
            onClick={() => {
              run(() => {
                onIssueOtp(user);
              });
            }}
          >
            <KeyRound aria-hidden="true" size={14} />
            {ko.users.otp.issue}
          </Button>
          <Button
            role="menuitem"
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => {
              run(() => {
                onResetCredentials(user);
              });
            }}
          >
            <RotateCcwKey aria-hidden="true" size={14} />
            {ko.users.reset.action}
          </Button>
          {user.is_active ? (
            <Button
              role="menuitem"
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-red-700 hover:bg-red-50 hover:text-red-800"
              onClick={() => {
                run(() => {
                  onDeactivate(user);
                });
              }}
            >
              {ko.users.deactivate}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function UserFormDrawer({
  editing,
  branches,
  onSubmit,
  onClose,
}: {
  editing: UserSummary | undefined;
  branches: BranchSummary[];
  onSubmit: (body: CreateUserRequest | UpdateUserRequest) => Promise<void>;
  onClose: () => void;
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
  const selectedBranchLabels = branchIds.map(
    (id) => branches.find((branch) => branch.id === id)?.name ?? id,
  );
  const hasElevatedRole = roles.some((role) => ELEVATED_ROLES.has(role));

  // Close on Escape, matching the OTP/reset dialogs' keyboard affordance.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, pending]);

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
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editing ? ko.users.editTitle : ko.users.createTitle}
      className="fixed inset-0 z-40 flex justify-end bg-ink/40"
    >
      {/* Click-away scrim closes the editor. */}
      <button
        type="button"
        aria-label={ko.users.closeEditor}
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={() => {
          if (!pending) onClose();
        }}
      />
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-line bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white px-5 py-4">
          <h2 className="text-lg font-semibold text-ink">
            {editing ? ko.users.editTitle : ko.users.createTitle}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={ko.users.closeEditor}
            disabled={pending}
            onClick={onClose}
          >
            <X aria-hidden="true" size={18} />
          </Button>
        </div>

        <div className="grid gap-4 p-5">
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
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
              className="text-sm font-medium text-steel"
              htmlFor="user-phone"
            >
              {ko.users.form.phone}
            </label>
            <Input
              id="user-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              value={phone}
              placeholder={ko.users.form.phonePlaceholder}
              onChange={(event) => {
                setPhone(event.currentTarget.value);
              }}
            />
          </div>

          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="user-team"
            >
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
            <legend className="text-sm font-medium text-steel">
              {ko.users.form.roles}
            </legend>
            <div className="grid gap-1">
              {ASSIGNABLE_ROLES.map((role) => (
                <label
                  key={role}
                  className="flex items-center gap-2 text-sm text-steel"
                >
                  <input
                    type="checkbox"
                    className="size-4 rounded border-line"
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
            <legend className="text-sm font-medium text-steel">
              {ko.users.form.branches}
            </legend>
            {branches.length === 0 ? (
              <p className="text-sm text-steel">
                {ko.users.form.noBranchOptions}
              </p>
            ) : (
              <>
                <p className="text-xs text-steel">
                  {ko.users.form.branchesHint}
                </p>
                <div className="grid gap-1">
                  {branches.map((branch) => (
                    <label
                      key={branch.id}
                      className="flex items-center gap-2 text-sm text-steel"
                    >
                      <input
                        type="checkbox"
                        className="size-4 rounded border-line"
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

          <Card
            aria-labelledby="user-policy-preview-title"
            className="grid gap-3 border-brand-teal/20 bg-brand-teal/5"
            role="region"
          >
            <div>
              <p className="text-sm font-semibold text-brand-teal">
                {ko.users.form.policyPreview.eyebrow}
              </p>
              <h3 id="user-policy-preview-title" className="mt-1 font-semibold text-ink">
                {ko.users.form.policyPreview.title}
              </h3>
              <p className="mt-1 text-sm text-steel">
                {ko.users.form.policyPreview.description}
              </p>
            </div>
            <div className="grid gap-2 rounded-lg border border-line bg-white p-3 text-sm text-steel">
              <p>
                <span className="font-semibold text-ink">
                  {ko.users.form.policyPreview.teamLabel}
                </span>{" "}
                {teamLabel(team)}
              </p>
              <p>
                <span className="font-semibold text-ink">
                  {ko.users.form.policyPreview.rolesLabel}
                </span>{" "}
                {roles.length > 0
                  ? roles.map((role) => roleLabel(role)).join(", ")
                  : ko.users.form.policyPreview.none}
              </p>
              <p>
                <span className="font-semibold text-ink">
                  {ko.users.form.policyPreview.scopeLabel}
                </span>{" "}
                {selectedBranchLabels.length > 0
                  ? selectedBranchLabels.join(", ")
                  : ko.users.form.policyPreview.none}
              </p>
              <p>
                <span className="font-semibold text-ink">
                  {ko.users.form.policyPreview.futureLabel}
                </span>{" "}
                {ko.users.form.policyPreview.futureValue}
              </p>
              <p>{ko.users.form.policyPreview.configurable}</p>
              {hasElevatedRole ? (
                <p className="rounded-md border border-signal/30 bg-signal/10 p-2 font-medium text-ink">
                  {ko.users.form.policyPreview.elevated}
                </p>
              ) : null}
            </div>
          </Card>

          {error ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}
        </div>

        <div className="sticky bottom-0 z-10 mt-auto flex items-center gap-2 border-t border-line bg-white px-5 py-4">
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
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={onClose}
          >
            {ko.users.form.cancel}
          </Button>
        </div>
      </div>
    </div>
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
  // The "copied" confirmation reverts to the default copy label after a moment.
  const clearCopied = useCallback(() => {
    setCopied(false);
  }, []);
  useAutoDismiss(copied ? "copied" : undefined, clearCopied, SUCCESS_DISMISS_MS);

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
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
    >
      <Card className="grid w-full max-w-md gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold text-ink">
            {ko.users.otp.title}
          </h2>
          <p className="text-sm text-steel">{ko.users.otp.description}</p>
          <p className="text-sm font-medium text-steel">
            {user.display_name}
          </p>
        </div>

        {branchId ? (
          <p className="text-sm text-steel">
            {ko.users.otp.branchLabel}: {branchName(branchId)}
          </p>
        ) : (
          <p role="alert" className="text-sm font-medium text-red-700">
            {ko.users.otp.noBranch}
          </p>
        )}

        {issued ? (
          <div className="grid gap-2 rounded-md border border-brand-teal/30 bg-brand-teal/10 p-4">
            <span className="text-sm font-medium text-brand-teal">
              {ko.users.otp.issued}
            </span>
            <div className="flex items-center gap-2">
              <code className="rounded bg-white px-3 py-2 text-lg font-semibold tracking-widest text-ink">
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
            <span className="text-sm text-brand-teal">
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

function ResetCredentialsDialog({
  user,
  onClose,
}: {
  user: UserSummary;
  onClose: () => void;
}) {
  const { api } = useAuth();
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<IssuedOtp | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // The "copied" confirmation reverts to the default copy label after a moment.
  const clearCopied = useCallback(() => {
    setCopied(false);
  }, []);
  useAutoDismiss(copied ? "copied" : undefined, clearCopied, SUCCESS_DISMISS_MS);

  async function handleReset() {
    // The reset dialog itself is the destructive-action confirmation surface:
    // it shows the red "existing passkeys will be removed" warning and gates the
    // mutation behind this explicit button. No redundant native window.confirm.
    setError(undefined);
    setCopied(false);
    setPending(true);
    try {
      const result = await resetUserCredentials(api, { user_id: user.id });
      setIssued({ otp: result.otp, expiresAt: result.expires_at });
    } catch {
      setError(ko.users.reset.failed);
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
      aria-label={ko.users.reset.title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
    >
      <Card className="grid w-full max-w-md gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold text-ink">
            {ko.users.reset.title}
          </h2>
          <p className="text-sm text-steel">
            {ko.users.reset.description}
          </p>
          <p className="text-sm font-medium text-steel">
            {user.display_name}
          </p>
        </div>

        <p
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900"
        >
          {ko.users.reset.warning}
        </p>

        {issued ? (
          <div className="grid gap-2 rounded-md border border-brand-teal/30 bg-brand-teal/10 p-4">
            <span className="text-sm font-medium text-brand-teal">
              {ko.users.reset.issued}
            </span>
            <div className="flex items-center gap-2">
              <code className="rounded bg-white px-3 py-2 text-lg font-semibold tracking-widest text-ink">
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
                {copied ? ko.users.reset.copied : ko.users.reset.copy}
              </Button>
            </div>
            <span role="status" aria-live="polite" className="sr-only">
              {copied ? ko.users.reset.copied : ""}
            </span>
            <span className="text-sm text-brand-teal">
              {ko.users.reset.expiresAt}:{" "}
              {new Date(issued.expiresAt).toLocaleString("ko-KR", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
            <span className="text-sm text-brand-teal">
              {ko.users.reset.handoff}
            </span>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          {!issued ? (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void handleReset();
              }}
            >
              <RotateCcwKey aria-hidden="true" size={18} />
              {pending ? ko.users.reset.submitting : ko.users.reset.submit}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            {ko.users.reset.close}
          </Button>
        </div>
      </Card>
    </div>
  );
}
