import { Building2, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { BranchSummary, RegionSummary } from "../api/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

/**
 * A referential-guard conflict (HTTP 409) raised by a deactivate call. Carries a
 * caller-facing Korean message so the panel can surface the precise reason the
 * delete was refused rather than a generic failure.
 */
class GuardConflictError extends Error {}

export function OrgPage() {
  const { api } = useAuth();

  const [regions, setRegions] = useState<RegionSummary[]>([]);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [state, setState] = useState<ReadState>("loading");
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setState("loading");
    const [regionsRes, branchesRes] = await Promise.all([
      api.GET("/api/v1/regions").catch(() => undefined),
      api.GET("/api/v1/branches").catch(() => undefined),
    ]);
    if (!regionsRes?.data || !branchesRes?.data) {
      setState("error");
      return;
    }
    setRegions(regionsRes.data);
    setBranches(branchesRes.data);
    setState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const regionName = useCallback(
    (id: string) =>
      regions.find((r) => r.id === id)?.name ?? ko.org.branches.unknownRegion,
    [regions],
  );

  async function createRegion(name: string): Promise<void> {
    const response = await api.POST("/api/v1/regions", { body: { name } });
    if (!response.data) throw new Error("createRegion failed");
    setFeedback(ko.org.regions.created);
    await load();
  }

  async function updateRegion(id: string, name: string): Promise<void> {
    const response = await api.PATCH("/api/v1/regions/{id}", {
      params: { path: { id } },
      body: { name },
    });
    if (!response.data) throw new Error("updateRegion failed");
    setFeedback(ko.org.regions.saved);
    await load();
  }

  async function deleteRegion(id: string): Promise<void> {
    const response = await api.DELETE("/api/v1/regions/{id}", {
      params: { path: { id } },
    });
    if (response.response.status === 409) {
      throw new GuardConflictError(ko.org.regions.deleteBlocked);
    }
    if (response.error || !response.response.ok) {
      throw new Error("deleteRegion failed");
    }
    setFeedback(ko.org.regions.deleted);
    await load();
  }

  async function createBranch(name: string, regionId: string): Promise<void> {
    const response = await api.POST("/api/v1/branches", {
      body: { name, region_id: regionId },
    });
    if (!response.data) throw new Error("createBranch failed");
    setFeedback(ko.org.branches.created);
    await load();
  }

  async function updateBranch(
    id: string,
    name: string,
    regionId: string,
  ): Promise<void> {
    const response = await api.PATCH("/api/v1/branches/{id}", {
      params: { path: { id } },
      body: { name, region_id: regionId },
    });
    if (!response.data) throw new Error("updateBranch failed");
    setFeedback(ko.org.branches.saved);
    await load();
  }

  async function deleteBranch(id: string): Promise<void> {
    const response = await api.DELETE("/api/v1/branches/{id}", {
      params: { path: { id } },
    });
    if (response.response.status === 409) {
      throw new GuardConflictError(ko.org.branches.deleteBlocked);
    }
    if (response.error || !response.response.ok) {
      throw new Error("deleteBranch failed");
    }
    setFeedback(ko.org.branches.deleted);
    await load();
  }

  return (
    <>
      <PageHeader
        title={ko.org.title}
        description={ko.org.description}
        actions={
          <RefreshButton
            onClick={() => {
              void load();
            }}
            isLoading={state === "loading"}
          />
        }
      />

      {feedback ? (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-brand-teal/30 bg-brand-teal/10 px-4 py-2 text-sm font-medium text-brand-teal"
        >
          {feedback}
        </p>
      ) : null}

      {state === "error" ? (
        <PageError
          message={ko.org.loadFailed}
          onRetry={() => {
            void load();
          }}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <RegionsPanel
            regions={regions}
            branches={branches}
            isLoading={state === "loading"}
            onCreate={createRegion}
            onUpdate={updateRegion}
            onDelete={deleteRegion}
            onChanged={() => {
              setFeedback(undefined);
            }}
          />
          <BranchesPanel
            regions={regions}
            branches={branches}
            isLoading={state === "loading"}
            regionName={regionName}
            onCreate={createBranch}
            onUpdate={updateBranch}
            onDelete={deleteBranch}
            onChanged={() => {
              setFeedback(undefined);
            }}
          />
        </div>
      )}
    </>
  );
}

function RegionsPanel({
  regions,
  branches,
  isLoading,
  onCreate,
  onUpdate,
  onDelete,
  onChanged,
}: {
  regions: RegionSummary[];
  branches: BranchSummary[];
  isLoading: boolean;
  onCreate: (name: string) => Promise<void>;
  onUpdate: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);

  function branchCount(regionId: string): number {
    return branches.filter((b) => b.region_id === regionId).length;
  }

  async function handleCreate() {
    setError(undefined);
    onChanged();
    if (!name.trim()) {
      setError(ko.org.regions.requiredName);
      return;
    }
    setPending(true);
    try {
      await onCreate(name.trim());
      setName("");
    } catch {
      setError(ko.org.regions.createFailed);
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(id: string) {
    setError(undefined);
    onChanged();
    setDeletingId(id);
    try {
      await onDelete(id);
      setConfirmId(undefined);
    } catch (cause) {
      setError(
        cause instanceof GuardConflictError
          ? cause.message
          : ko.org.regions.deleteFailed,
      );
    } finally {
      setDeletingId(undefined);
    }
  }

  return (
    <Card className="grid gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
        <MapPin aria-hidden="true" size={18} />
        {ko.org.regions.title}
      </h2>

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="region-name"
        >
          {ko.org.regions.nameLabel}
        </label>
        <div className="flex items-start gap-2">
          <Input
            id="region-name"
            value={name}
            placeholder={ko.org.regions.namePlaceholder}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
          />
          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              void handleCreate();
            }}
          >
            <Plus aria-hidden="true" size={18} />
            {pending ? ko.org.regions.creating : ko.org.regions.create}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <p role="status" className="text-sm font-medium text-steel">
          {ko.common.loading}
        </p>
      ) : regions.length === 0 ? (
        <PageEmpty message={ko.org.regions.empty} />
      ) : (
        <ul className="grid gap-2">
          {regions.map((region) =>
            editingId === region.id ? (
              <li key={region.id}>
                <RegionEditRow
                  region={region}
                  onCancel={() => {
                    setEditingId(undefined);
                  }}
                  onSave={async (nextName) => {
                    onChanged();
                    await onUpdate(region.id, nextName);
                    setEditingId(undefined);
                  }}
                />
              </li>
            ) : (
              <li
                key={region.id}
                className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
              >
                <span className="min-w-0 font-medium text-ink">
                  {region.name}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-steel">
                    {ko.org.regions.branchCount}: {branchCount(region.id)}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onChanged();
                      setError(undefined);
                      setEditingId(region.id);
                    }}
                  >
                    <Pencil aria-hidden="true" size={14} />
                    {ko.org.regions.edit}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      onChanged();
                      setError(undefined);
                      setConfirmId(region.id);
                    }}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    {ko.org.regions.delete}
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {confirmId ? (
        <ConfirmDeleteDialog
          title={ko.org.regions.deleteConfirmTitle}
          body={ko.org.regions.deleteConfirmBody}
          confirmLabel={ko.org.regions.delete}
          pendingLabel={ko.org.regions.deleting}
          pending={deletingId !== undefined}
          onCancel={() => {
            setConfirmId(undefined);
          }}
          onConfirm={() => {
            void handleDelete(confirmId);
          }}
        />
      ) : null}
    </Card>
  );
}

function RegionEditRow({
  region,
  onCancel,
  onSave,
}: {
  region: RegionSummary;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(region.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSave() {
    setError(undefined);
    if (!name.trim()) {
      setError(ko.org.regions.requiredName);
      return;
    }
    setPending(true);
    try {
      await onSave(name.trim());
    } catch {
      setError(ko.org.regions.saveFailed);
      setPending(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-md border border-line bg-muted-panel p-3">
      <Input
        aria-label={ko.org.regions.nameLabel}
        value={name}
        onChange={(event) => {
          setName(event.currentTarget.value);
        }}
      />
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => {
            void handleSave();
          }}
        >
          {pending ? ko.org.regions.saving : ko.org.regions.save}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={onCancel}
        >
          {ko.org.regions.cancel}
        </Button>
      </div>
    </div>
  );
}

function BranchesPanel({
  regions,
  branches,
  isLoading,
  regionName,
  onCreate,
  onUpdate,
  onDelete,
  onChanged,
}: {
  regions: RegionSummary[];
  branches: BranchSummary[];
  isLoading: boolean;
  regionName: (id: string) => string;
  onCreate: (name: string, regionId: string) => Promise<void>;
  onUpdate: (id: string, name: string, regionId: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [regionId, setRegionId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);

  async function handleCreate() {
    setError(undefined);
    onChanged();
    if (!name.trim()) {
      setError(ko.org.branches.requiredName);
      return;
    }
    if (!regionId) {
      setError(ko.org.branches.requiredRegion);
      return;
    }
    setPending(true);
    try {
      await onCreate(name.trim(), regionId);
      setName("");
      setRegionId("");
    } catch {
      setError(ko.org.branches.createFailed);
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(id: string) {
    setError(undefined);
    onChanged();
    setDeletingId(id);
    try {
      await onDelete(id);
      setConfirmId(undefined);
    } catch (cause) {
      setError(
        cause instanceof GuardConflictError
          ? cause.message
          : ko.org.branches.deleteFailed,
      );
    } finally {
      setDeletingId(undefined);
    }
  }

  return (
    <Card className="grid gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
        <Building2 aria-hidden="true" size={18} />
        {ko.org.branches.title}
      </h2>

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="branch-name"
        >
          {ko.org.branches.nameLabel}
        </label>
        <Input
          id="branch-name"
          value={name}
          placeholder={ko.org.branches.namePlaceholder}
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
        />
        <label
          className="text-sm font-medium text-steel"
          htmlFor="branch-region"
        >
          {ko.org.branches.regionLabel}
        </label>
        {regions.length === 0 ? (
          <p className="text-sm text-steel">{ko.org.branches.noRegions}</p>
        ) : (
          <Select
            id="branch-region"
            value={regionId}
            onChange={(event) => {
              setRegionId(event.currentTarget.value);
            }}
          >
            <option value="">{ko.org.branches.regionPlaceholder}</option>
            {regions.map((region) => (
              <option key={region.id} value={region.id}>
                {region.name}
              </option>
            ))}
          </Select>
        )}
        <Button
          type="button"
          disabled={pending || regions.length === 0}
          onClick={() => {
            void handleCreate();
          }}
        >
          <Plus aria-hidden="true" size={18} />
          {pending ? ko.org.branches.creating : ko.org.branches.create}
        </Button>
        {error ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <p role="status" className="text-sm font-medium text-steel">
          {ko.common.loading}
        </p>
      ) : branches.length === 0 ? (
        <PageEmpty message={ko.org.branches.empty} />
      ) : (
        <ul className="grid gap-2">
          {branches.map((branch) =>
            editingId === branch.id ? (
              <li key={branch.id}>
                <BranchEditRow
                  branch={branch}
                  regions={regions}
                  onCancel={() => {
                    setEditingId(undefined);
                  }}
                  onSave={async (nextName, nextRegionId) => {
                    onChanged();
                    await onUpdate(branch.id, nextName, nextRegionId);
                    setEditingId(undefined);
                  }}
                />
              </li>
            ) : (
              <li
                key={branch.id}
                className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-ink">{branch.name}</p>
                  <p className="text-steel">{regionName(branch.region_id)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onChanged();
                      setError(undefined);
                      setEditingId(branch.id);
                    }}
                  >
                    <Pencil aria-hidden="true" size={14} />
                    {ko.org.branches.edit}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      onChanged();
                      setError(undefined);
                      setConfirmId(branch.id);
                    }}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    {ko.org.branches.delete}
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {confirmId ? (
        <ConfirmDeleteDialog
          title={ko.org.branches.deleteConfirmTitle}
          body={ko.org.branches.deleteConfirmBody}
          confirmLabel={ko.org.branches.delete}
          pendingLabel={ko.org.branches.deleting}
          pending={deletingId !== undefined}
          onCancel={() => {
            setConfirmId(undefined);
          }}
          onConfirm={() => {
            void handleDelete(confirmId);
          }}
        />
      ) : null}
    </Card>
  );
}

function BranchEditRow({
  branch,
  regions,
  onCancel,
  onSave,
}: {
  branch: BranchSummary;
  regions: RegionSummary[];
  onCancel: () => void;
  onSave: (name: string, regionId: string) => Promise<void>;
}) {
  const [name, setName] = useState(branch.name);
  const [regionId, setRegionId] = useState(branch.region_id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSave() {
    setError(undefined);
    if (!name.trim()) {
      setError(ko.org.branches.requiredName);
      return;
    }
    setPending(true);
    try {
      await onSave(name.trim(), regionId);
    } catch {
      setError(ko.org.branches.saveFailed);
      setPending(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-md border border-line bg-muted-panel p-3">
      <Input
        aria-label={ko.org.branches.nameLabel}
        value={name}
        onChange={(event) => {
          setName(event.currentTarget.value);
        }}
      />
      <Select
        aria-label={ko.org.branches.regionLabel}
        value={regionId}
        onChange={(event) => {
          setRegionId(event.currentTarget.value);
        }}
      >
        {regions.map((region) => (
          <option key={region.id} value={region.id}>
            {region.name}
          </option>
        ))}
      </Select>
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => {
            void handleSave();
          }}
        >
          {pending ? ko.org.branches.saving : ko.org.branches.save}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={onCancel}
        >
          {ko.org.branches.cancel}
        </Button>
      </div>
    </div>
  );
}

function ConfirmDeleteDialog({
  title,
  body,
  confirmLabel,
  pendingLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
    >
      <Card className="grid w-full max-w-md gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <p className="text-sm text-steel">{body}</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={onCancel}
          >
            {ko.org.branches.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}
