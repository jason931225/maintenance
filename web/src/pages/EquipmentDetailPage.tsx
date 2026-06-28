import { Pencil } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import type {
  ExecuteObjectActionRequest,
  EquipmentGraphNode,
  EquipmentLifecycleEvent,
  EquipmentListItem,
  EquipmentTimelineGraph,
  ObjectActionCatalogResponse,
  ObjectActionDescriptor,
  ObjectActionExecutionResponse,
  ObjectActionFieldDescriptor,
} from "../api/types";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { PageHeader } from "../components/shell/PageHeader";
import { PageSpinner } from "../components/states/PageSpinner";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { assertPasskeyStepUp } from "../auth/webauthn";
import { EquipmentDetailDialog } from "../features/equipment/EquipmentDetailDialog";
import { equipmentStatusBadgeClass } from "../features/equipment/equipment-format";
import {
  ObjectViewField,
  ObjectViewPanel,
  ObjectViewProperties,
  ObjectViewScaffold,
} from "../features/object-view/ObjectViewScaffold";
import { useAuth } from "../context/auth";
import { formatKoreanDate, formatKoreanDateTime } from "../lib/datetime";
import { Mono } from "../lib/format";
import { safeLabel } from "../lib/utils";
import { ko } from "../i18n/ko";

const EQUIPMENT_MANAGE_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

type ReadState = "loading" | "ready" | "not-found" | "error";

type EquipmentLocationState = {
  equipment?: EquipmentListItem;
} | null;

function stateEquipment(value: unknown): EquipmentListItem | undefined {
  const maybe = value as EquipmentLocationState;
  return maybe?.equipment;
}

async function readEquipmentById(
  api: ReturnType<typeof useAuth>["api"],
  equipmentId: string,
): Promise<EquipmentListItem | undefined> {
  const response = await api.GET("/api/v1/equipment/{id}", {
    params: { path: { id: equipmentId } },
  });
  if (response.response.status === 404) {
    return undefined;
  }
  if (!response.data) {
    throw new Error("equipment detail response missing data");
  }
  return response.data;
}

async function readEquipmentTimelineGraph(
  api: ReturnType<typeof useAuth>["api"],
  equipmentId: string,
): Promise<EquipmentTimelineGraph | undefined> {
  const response = await api.GET("/api/v1/equipment/{id}/timeline-graph", {
    params: { path: { id: equipmentId } },
  });
  if (response.response.status === 404) {
    return undefined;
  }
  if (!response.data) {
    throw new Error("equipment timeline graph response missing data");
  }
  return response.data;
}

async function readObjectActionCatalog(
  api: ReturnType<typeof useAuth>["api"],
  equipmentId: string,
): Promise<ObjectActionCatalogResponse | undefined> {
  const response = await api.GET("/api/v1/object-actions/catalog", {
    params: {
      query: {
        object_type: "equipment",
        object_id: equipmentId,
      },
    },
  });
  if (response.response.status === 404) {
    return undefined;
  }
  if (!response.data) {
    throw new Error("object action catalog response missing data");
  }
  return response.data;
}

export function EquipmentDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { api, session } = useAuth();
  const canManage = hasAnyRole(session?.roles, EQUIPMENT_MANAGE_ROLES);
  const seededItem =
    stateEquipment(location.state)?.equipment_id === id
      ? stateEquipment(location.state)
      : undefined;

  const [item, setItem] = useState<EquipmentListItem | undefined>(seededItem);
  const [readState, setReadState] = useState<ReadState>(
    seededItem ? "ready" : id ? "loading" : "not-found",
  );
  const [lens, setLens] = useState<EquipmentTimelineGraph | undefined>();
  const [lensState, setLensState] = useState<ReadState>(
    id ? "loading" : "not-found",
  );
  const [actionCatalog, setActionCatalog] =
    useState<ObjectActionCatalogResponse>();
  const [actionState, setActionState] = useState<ReadState>(
    id && canManage ? "loading" : "not-found",
  );
  const [editItem, setEditItem] = useState<EquipmentListItem | undefined>();
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!id || (seededItem && reloadNonce === 0)) return;
    let active = true;

    void readEquipmentById(api, id)
      .then((found) => {
        if (!active) return;
        setItem(found);
        setReadState(found ? "ready" : "not-found");
      })
      .catch(() => {
        if (!active) return;
        setReadState("error");
      });

    return () => {
      active = false;
    };
  }, [api, id, reloadNonce, seededItem]);

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(async () => {
        if (!id) {
          return { kind: "missing" as const };
        }
        if (!active) {
          return { kind: "cancelled" as const };
        }
        setLensState("loading");
        const found = await readEquipmentTimelineGraph(api, id);
        return { kind: "found" as const, found };
      })
      .then((result) => {
        if (!active || result.kind === "cancelled") return;
        if (result.kind === "missing") {
          setLens(undefined);
          setLensState("not-found");
          return;
        }
        setLens(result.found);
        setLensState(result.found ? "ready" : "not-found");
      })
      .catch(() => {
        if (!active) return;
        setLensState("error");
      });

    return () => {
      active = false;
    };
  }, [api, id, reloadNonce]);

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(async () => {
        if (!id || !canManage) {
          return { kind: "missing" as const };
        }
        if (!active) {
          return { kind: "cancelled" as const };
        }
        setActionState("loading");
        const found = await readObjectActionCatalog(api, id);
        return { kind: "found" as const, found };
      })
      .then((result) => {
        if (!active || result.kind === "cancelled") return;
        if (result.kind === "missing") {
          setActionCatalog(undefined);
          setActionState("not-found");
          return;
        }
        setActionCatalog(result.found);
        setActionState(result.found ? "ready" : "not-found");
      })
      .catch(() => {
        if (!active) return;
        setActionState("error");
      });

    return () => {
      active = false;
    };
  }, [api, canManage, id]);

  function retryLoad() {
    if (!id) {
      setReadState("not-found");
      return;
    }
    setItem(undefined);
    setLens(undefined);
    setActionCatalog(undefined);
    setReadState("loading");
    setLensState("loading");
    setActionState(canManage ? "loading" : "not-found");
    setReloadNonce((value) => value + 1);
  }

  function handleUpdated(updated: EquipmentListItem) {
    setItem(updated);
    setEditItem(undefined);
  }

  function handleActionExecuted() {
    if (!id) return;
    setReloadNonce((value) => value + 1);
  }

  return (
    <>
      <PageHeader
        title={ko.equipment.detail.title}
        description={ko.equipment.detail.description}
      />

      {readState === "loading" ? <PageSpinner /> : null}
      {readState === "error" ? (
        <PageError
          message={ko.equipment.detail.loadFailed}
          onRetry={retryLoad}
        />
      ) : null}
      {readState === "not-found" ? (
        <PageEmpty message={ko.equipment.detail.notFound} />
      ) : null}
      {readState === "ready" && item ? (
        <ObjectViewScaffold className="lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <div className="grid gap-5">
            <EquipmentIdentityPanel item={item} />
            <EquipmentAssignmentPanel item={item} />
            <EquipmentLifecyclePanel
              lens={lens}
              state={lensState}
              onRetry={retryLoad}
            />
            <EquipmentRelationshipGraphPanel lens={lens} state={lensState} />
          </div>
          <EquipmentLinksPanel
            item={item}
            canManage={canManage}
            api={api}
            actionCatalog={actionCatalog}
            actionState={actionState}
            onEdit={() => {
              setEditItem(item);
            }}
            onActionExecuted={handleActionExecuted}
          />
        </ObjectViewScaffold>
      ) : null}

      <EquipmentDetailDialog
        key={editItem?.equipment_id ?? "closed"}
        item={editItem}
        canManage={canManage}
        api={api}
        referenceItems={item ? [item] : []}
        onClose={() => {
          setEditItem(undefined);
        }}
        onUpdated={handleUpdated}
      />
    </>
  );
}

function EquipmentIdentityPanel({ item }: { item: EquipmentListItem }) {
  const t = ko.equipment.detail;
  return (
    <ObjectViewPanel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-steel">{t.fields.equipmentNo}</p>
          <p className="text-xl font-semibold text-ink">
            <Mono>{item.equipment_no}</Mono>
          </p>
        </div>
        <Badge className={equipmentStatusBadgeClass(item.status)}>
          {ko.equipment.statuses[item.status]}
        </Badge>
      </div>
      <ObjectViewProperties>
        <ObjectViewField label={t.fields.managementNo}>
          {item.management_no ? <Mono>{item.management_no}</Mono> : t.empty}
        </ObjectViewField>
        <ObjectViewField label={t.fields.model}>
          {safeLabel(item.model, t.empty)}
        </ObjectViewField>
        <ObjectViewField label={t.fields.maker}>
          {safeLabel(item.maker, t.empty)}
        </ObjectViewField>
        <ObjectViewField label={t.fields.specification}>
          {safeLabel(item.specification, t.empty)}
        </ObjectViewField>
        <ObjectViewField label={t.fields.tonText}>
          {safeLabel(item.ton_text, t.empty)}
        </ObjectViewField>
        <ObjectViewField label={t.fields.vin}>
          {item.vin ? <Mono>{safeLabel(item.vin, t.empty)}</Mono> : t.empty}
        </ObjectViewField>
        <ObjectViewField label={t.fields.updatedAt}>
          {formatKoreanDate(item.updated_at)}
        </ObjectViewField>
      </ObjectViewProperties>
    </ObjectViewPanel>
  );
}

function EquipmentAssignmentPanel({ item }: { item: EquipmentListItem }) {
  const t = ko.equipment.detail;
  return (
    <ObjectViewPanel title={t.assignmentTitle}>
      <ObjectViewProperties>
        <ObjectViewField label={t.fields.customerName}>
          {safeLabel(item.customer_name, t.empty)}
        </ObjectViewField>
        <ObjectViewField label={t.fields.siteName}>
          {safeLabel(item.site_name, t.empty)}
        </ObjectViewField>
      </ObjectViewProperties>
    </ObjectViewPanel>
  );
}

function EquipmentLifecyclePanel({
  lens,
  state,
  onRetry,
}: {
  lens: EquipmentTimelineGraph | undefined;
  state: ReadState;
  onRetry: () => void;
}) {
  const t = ko.equipment.detail;
  return (
    <ObjectViewPanel
      title={t.timelineTitle}
      description={t.timelineDescription}
    >
      {state === "loading" ? (
        <p aria-busy="true" className="text-sm text-steel">
          {ko.page.loading}
        </p>
      ) : null}
      {state === "error" ? (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          <p>{t.timelineLoadFailed}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={onRetry}
          >
            {ko.page.retry}
          </Button>
        </div>
      ) : null}
      {state === "ready" && lens && lens.lifecycle_events.length === 0 ? (
        <p className="text-sm text-steel">{t.timelineEmpty}</p>
      ) : null}
      {state === "ready" && lens && lens.lifecycle_events.length > 0 ? (
        <ol className="grid gap-3 md:grid-cols-2" aria-label={t.timelineTitle}>
          {lens.lifecycle_events.map((event) => (
            <EquipmentLifecycleEventCard key={event.id} event={event} />
          ))}
        </ol>
      ) : null}
    </ObjectViewPanel>
  );
}

function EquipmentLifecycleEventCard({
  event,
}: {
  event: EquipmentLifecycleEvent;
}) {
  const content = (
    <div className="rounded-xl border border-line bg-surface p-3 transition hover:border-accent/50">
      <p className="text-sm font-semibold text-ink">{event.label}</p>
      <p className="mt-1 text-xs text-steel">
        {formatLifecycleEventDate(event)}
      </p>
      {event.description ? (
        <p className="mt-2 text-sm text-steel">{event.description}</p>
      ) : null}
    </div>
  );

  return (
    <li className="relative pl-4 before:absolute before:left-0 before:top-2 before:h-2 before:w-2 before:rounded-full before:bg-accent">
      {event.href ? (
        <Link
          to={event.href}
          className="block focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {content}
        </Link>
      ) : (
        content
      )}
    </li>
  );
}

function EquipmentRelationshipGraphPanel({
  lens,
  state,
}: {
  lens: EquipmentTimelineGraph | undefined;
  state: ReadState;
}) {
  const t = ko.equipment.detail;
  const nodes = lens?.graph.nodes ?? [];
  const edges = lens?.graph.edges ?? [];
  return (
    <ObjectViewPanel title={t.graphTitle} description={t.graphDescription}>
      {state === "loading" ? (
        <p aria-busy="true" className="text-sm text-steel">
          {ko.page.loading}
        </p>
      ) : null}
      {state === "error" ? (
        <p className="text-sm text-danger">{t.timelineLoadFailed}</p>
      ) : null}
      {state === "ready" && nodes.length === 0 ? (
        <p className="text-sm text-steel">{t.graphEmpty}</p>
      ) : null}
      {state === "ready" && nodes.length > 0 ? (
        <div className="grid gap-4">
          <p className="text-sm text-steel">{formatGraphStats(lens)}</p>
          <div
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
            aria-label={t.graphTitle}
          >
            {nodes.map((node) => (
              <EquipmentGraphNodeCard key={node.id} node={node} />
            ))}
          </div>
          {edges.length > 0 ? (
            <ul
              className="flex flex-wrap gap-2"
              aria-label={t.graphDescription}
            >
              {edges.map((edge) => (
                <li
                  key={`${edge.from}-${edge.to}-${edge.kind}`}
                  className="rounded-full border border-line bg-muted px-3 py-1 text-xs text-steel"
                >
                  {edge.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </ObjectViewPanel>
  );
}

function EquipmentGraphNodeCard({ node }: { node: EquipmentGraphNode }) {
  const card = (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">{node.label}</p>
          {node.subtitle ? (
            <p className="mt-1 text-xs text-steel">{node.subtitle}</p>
          ) : null}
        </div>
        {node.current ? (
          <Badge className="min-h-0 border-accent/40 text-accent">
            {ko.equipment.detail.graphCurrent}
          </Badge>
        ) : null}
      </div>
    </div>
  );

  return node.href ? (
    <Link
      to={node.href}
      className="block focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {card}
    </Link>
  ) : (
    card
  );
}

function formatLifecycleEventDate(event: EquipmentLifecycleEvent): string {
  if (event.occurred_at) return formatKoreanDateTime(event.occurred_at);
  return formatKoreanDate(event.event_date);
}

function formatGraphStats(lens: EquipmentTimelineGraph | undefined): string {
  const t = ko.equipment.detail.graphStats;
  return t
    .replace("{count}", String(lens?.work_order_count ?? 0))
    .replace(
      "{amount}",
      (lens?.cost_ledger_total_won ?? 0).toLocaleString("ko-KR"),
    );
}

function EquipmentLinksPanel({
  item,
  canManage,
  api,
  actionCatalog,
  actionState,
  onEdit,
  onActionExecuted,
}: {
  item: EquipmentListItem;
  canManage: boolean;
  api: ReturnType<typeof useAuth>["api"];
  actionCatalog: ObjectActionCatalogResponse | undefined;
  actionState: ReadState;
  onEdit: () => void;
  onActionExecuted: () => void;
}) {
  const t = ko.equipment.detail;
  return (
    <aside className="grid gap-5">
      <ObjectViewPanel title={t.actionsTitle}>
        <div className="grid gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link to="/equipment">{t.backToList}</Link>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link to="/financial">{t.financialLink}</Link>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link to="/dispatch-map">{t.mapLink}</Link>
          </Button>
          {canManage ? (
            <Button type="button" size="sm" onClick={onEdit}>
              <Pencil aria-hidden="true" size={16} />
              {t.editAction}
            </Button>
          ) : null}
        </div>
      </ObjectViewPanel>
      {canManage ? (
        <EquipmentActionCatalogPanel
          item={item}
          api={api}
          catalog={actionCatalog}
          state={actionState}
          onActionExecuted={onActionExecuted}
        />
      ) : null}
      <ObjectViewPanel
        title={t.referenceTitle}
        description={t.referenceDescription}
      >
        <p className="text-sm text-steel">
          {t.referenceEquipmentNo}: <Mono>{item.equipment_no}</Mono>
        </p>
      </ObjectViewPanel>
    </aside>
  );
}

function EquipmentActionCatalogPanel({
  item,
  api,
  catalog,
  state,
  onActionExecuted,
}: {
  item: EquipmentListItem;
  api: ReturnType<typeof useAuth>["api"];
  catalog: ObjectActionCatalogResponse | undefined;
  state: ReadState;
  onActionExecuted: () => void;
}) {
  const t = ko.equipment.detail;
  return (
    <ObjectViewPanel
      title={t.actionCatalogTitle}
      description={t.actionCatalogDescription}
    >
      {state === "loading" ? (
        <p className="text-sm text-steel">{t.actionExecuting}</p>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="text-sm text-red-700">
          {t.actionCatalogLoadFailed}
        </p>
      ) : null}
      {state === "ready" && catalog?.actions.length === 0 ? (
        <p className="text-sm text-steel">{t.actionCatalogEmpty}</p>
      ) : null}
      {state === "ready" && catalog?.actions.length ? (
        <div className="grid gap-4">
          {catalog.actions.map((action) => (
            <EquipmentGeneratedActionForm
              key={`${item.equipment_id}:${action.action_id}`}
              item={item}
              action={action}
              api={api}
              onActionExecuted={onActionExecuted}
            />
          ))}
        </div>
      ) : null}
    </ObjectViewPanel>
  );
}

function EquipmentGeneratedActionForm({
  item,
  action,
  api,
  onActionExecuted,
}: {
  item: EquipmentListItem;
  action: ObjectActionDescriptor;
  api: ReturnType<typeof useAuth>["api"];
  onActionExecuted: () => void;
}) {
  const t = ko.equipment.detail;
  const [values, setValues] = useState<Record<string, string>>(() =>
    seedActionValues(action),
  );
  const [execution, setExecution] = useState<
    | { state: "idle" }
    | { state: "executing" }
    | { state: "succeeded"; receipt: ObjectActionExecutionResponse }
    | { state: "failed" }
  >({ state: "idle" });

  function setField(field: ObjectActionFieldDescriptor, value: string) {
    setValues((current) => ({
      ...current,
      [field.field_key]: value,
    }));
  }

  async function submitAction(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setExecution({ state: "executing" });
    try {
      const stepUp = action.requires_passkey_step_up
        ? await assertPasskeyStepUp(api)
        : undefined;
      const body: ExecuteObjectActionRequest = {
        action_id: "equipment.update_profile",
        object_type: "equipment",
        object_id: item.equipment_id,
        input: buildEquipmentActionInput(action, values),
        step_up: stepUp,
      };
      const response = await api.POST("/api/v1/object-actions/execute", {
        body,
      });
      if (!response.data) throw new Error("object action execution failed");
      setExecution({ state: "succeeded", receipt: response.data });
      onActionExecuted();
    } catch {
      setExecution({ state: "failed" });
    }
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        void submitAction(event);
      }}
    >
      <div className="grid gap-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">{action.label}</h3>
            <p className="text-xs text-steel">{action.description}</p>
          </div>
          {action.requires_passkey_step_up ? (
            <Badge>{t.actionPasskeyRequired}</Badge>
          ) : null}
        </div>
      </div>
      {action.fields.length === 0 ? (
        <p className="text-sm text-steel">{t.actionNoFields}</p>
      ) : (
        <div className="grid gap-2">
          {action.fields.map((field) => (
            <label
              key={field.field_key}
              className="grid gap-1 text-xs text-steel"
            >
              <span>{field.label}</span>
              {field.field_type === "select" ? (
                <Select
                  value={values[field.field_key] ?? ""}
                  onChange={(event) => {
                    setField(field, event.currentTarget.value);
                  }}
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={values[field.field_key] ?? ""}
                  onChange={(event) => {
                    setField(field, event.currentTarget.value);
                  }}
                />
              )}
            </label>
          ))}
        </div>
      )}
      {execution.state === "succeeded" ? (
        <FeedbackBanner
          kind="success"
          message={`${t.actionExecuted} ${t.actionAuditEvent}: ${execution.receipt.audit_event_id}`}
        />
      ) : null}
      {execution.state === "failed" ? (
        <FeedbackBanner kind="error" message={t.actionExecuteFailed} />
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={execution.state === "executing"}
      >
        {execution.state === "executing"
          ? t.actionExecuting
          : action.submit_label}
      </Button>
    </form>
  );
}

function seedActionValues(
  action: ObjectActionDescriptor,
): Record<string, string> {
  return Object.fromEntries(
    action.fields.map((field) => [field.field_key, field.current_value ?? ""]),
  );
}

function buildEquipmentActionInput(
  action: ObjectActionDescriptor,
  values: Record<string, string>,
): ExecuteObjectActionRequest["input"] {
  const nullableFields = new Set(["management_no", "model", "maker", "vin"]);
  return Object.fromEntries(
    action.fields
      .map((field) => {
        const value = (values[field.field_key] ?? "").trim();
        if (field.field_type === "select") {
          return [field.field_key, value] as const;
        }
        if (value.length > 0) {
          return [field.field_key, value] as const;
        }
        if (nullableFields.has(field.field_key)) {
          return [field.field_key, null] as const;
        }
        return undefined;
      })
      .filter((entry): entry is readonly [string, string | null] =>
        Boolean(entry),
      ),
  );
}
