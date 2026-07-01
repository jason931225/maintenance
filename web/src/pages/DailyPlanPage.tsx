import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type {
  CreateDailyPlanRequest,
  DailyPlanStatus,
  DailyPlanSummary,
  UserSummary,
  WorkOrderListItem,
} from "../api/types";
import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { PageHeader } from "../components/shell/PageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { ko } from "../i18n/ko";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../lib/useAutoDismiss";
import { todayInSeoul } from "../lib/utils";

/** DailyPlanRequest holders (backend matrix: MECHANIC/ADMIN/SUPER_ADMIN). */
const PLAN_REQUEST_ROLES = [
  ROLES.MECHANIC,
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN,
] as const;

/** DailyPlanReview holders (backend matrix: ADMIN/SUPER_ADMIN). */
const PLAN_REVIEW_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;

type WriteState = "idle" | "busy" | "error";

interface PlanItem {
  description: string;
}

interface DailyPlanItemSummary {
  work_order_id?: string | null;
  request_no?: string | null;
  equipment_no?: string | null;
  management_no?: string | null;
  customer_name?: string | null;
  site_name?: string | null;
  description: string;
  sort_order?: number;
}

type DailyPlanWithItems = DailyPlanSummary & {
  items?: DailyPlanItemSummary[];
};

const DAILY_PLAN_SOURCE_STATUSES: WorkOrderListItem["status"][] = [
  "RECEIVED",
  "UNASSIGNED",
  "ASSIGNED",
  "IN_PROGRESS",
  "ON_HOLD",
  "DELAYED",
  "TEMPORARY_ACTION",
  "PART_WAITING",
  "EQUIPMENT_IN_USE",
  "REVISIT_REQUIRED",
];

function today(): string {
  return todayInSeoul();
}

function formatWorkOrderOption(workOrder: WorkOrderListItem): string {
  const equipmentLabel =
    workOrder.equipment.management_no ||
    workOrder.equipment.equipment_no ||
    ko.dailyPlan.unknownEquipment;
  return [
    workOrder.request_no,
    equipmentLabel,
    `${workOrder.customer.name} / ${workOrder.site.name}`,
  ].join(" · ");
}

function formatDailyPlanItem(item: DailyPlanItemSummary): string {
  const source = [
    item.request_no,
    item.management_no ?? item.equipment_no,
    item.customer_name && item.site_name
      ? `${item.customer_name} / ${item.site_name}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return source ? `${source} — ${item.description}` : item.description;
}

export function DailyPlanPage() {
  const { api, session } = useAuth();
  const [searchParams] = useSearchParams();
  const branchId = session?.branches?.[0];
  const canRequest = hasAnyRole(session?.roles, PLAN_REQUEST_ROLES);
  const canReview = hasAnyRole(session?.roles, PLAN_REVIEW_ROLES);
  const isMechanic = hasAnyRole(session?.roles, [ROLES.MECHANIC]);

  const [mechanics, setMechanics] = useState<UserSummary[]>([]);
  const [sourceWorkOrders, setSourceWorkOrders] = useState<WorkOrderListItem[]>(
    [],
  );
  const [mechanicId, setMechanicId] = useState("");
  const [planDate, setPlanDate] = useState(today);
  const [sourceWorkOrderId, setSourceWorkOrderId] = useState("");
  const [items, setItems] = useState<PlanItem[]>([
    { description: "" },
  ]);
  const [reviewMemo, setReviewMemo] = useState("");
  const [plan, setPlan] = useState<DailyPlanWithItems>();
  const [plans, setPlans] = useState<DailyPlanWithItems[]>([]);
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [errorKey, setErrorKey] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const clearNotice = useCallback(() => {
    setNotice(undefined);
  }, []);
  useAutoDismiss(notice, clearNotice, SUCCESS_DISMISS_MS);

  const loadMechanics = useCallback(async () => {
    // Managers/reviewers can read the branch roster to plan for any mechanic.
    const response = await api
      .GET("/api/v1/users", { params: { query: { include_inactive: false } } })
      .catch(() => undefined);
    if (response?.data) {
      setMechanics(
        response.data.items.filter((user) => user.roles.includes("MECHANIC")),
      );
      return;
    }
    // A mechanic cannot list the roster (UserManage is admin-only); they only
    // ever plan for themselves, so fall back to their own profile so the selector
    // offers exactly the current mechanic.
    const me = await api.GET("/api/v1/users/me").catch(() => undefined);
    if (me?.data?.roles.includes("MECHANIC")) {
      setMechanics([me.data]);
    }
  }, [api]);

  useEffect(() => {
    if (!canRequest) return;
    void Promise.resolve().then(loadMechanics);
  }, [canRequest, loadMechanics]);

  const loadSourceWorkOrders = useCallback(async () => {
    const response = await api
      .GET("/api/v1/work-orders", {
        params: {
          query: {
            status: DAILY_PLAN_SOURCE_STATUSES,
            limit: 100,
            offset: 0,
          },
        },
      })
      .catch(() => undefined);
    if (response?.data) {
      setSourceWorkOrders(response.data.items);
    } else {
      setErrorKey("sourceWorkOrdersLoadFailed");
    }
  }, [api]);

  useEffect(() => {
    if (!canRequest) return;
    void Promise.resolve().then(loadSourceWorkOrders);
  }, [canRequest, loadSourceWorkOrders]);

  // The approval queue: every branch-scoped plan, DRAFT/REQUESTED included, so
  // approvers actually see plans awaiting them (#19.17). Replaces the prior
  // deep-link-only model where a created plan vanished from view.
  const loadPlans = useCallback(async () => {
    const response = await api
      .GET("/api/daily-work-plans", { params: { query: {} } })
      .catch(() => undefined);
    if (response?.data) {
      setPlans(response.data.items);
    } else {
      setErrorKey("queueLoadFailed");
    }
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(() => loadPlans());
  }, [loadPlans]);

  // Deep-link load: when arriving with ?planId=… (e.g. a reviewer re-opening a
  // plan after switching sessions), fetch that plan by id so the review/confirm
  // actions and status badge operate on real server state.
  const planIdParam = searchParams.get("planId");
  useEffect(() => {
    if (!planIdParam) return;
    void api
      .GET("/api/daily-work-plans/{planId}", {
        params: { path: { planId: planIdParam } },
      })
      .then((response) => {
        if (response.data) {
          setPlan(response.data);
          if (response.data.mechanic_id) setMechanicId(response.data.mechanic_id);
          if (response.data.plan_date) setPlanDate(response.data.plan_date);
        }
      })
      .catch(() => undefined);
  }, [api, planIdParam]);

  function setItemDescription(index: number, description: string) {
    setItems((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, description } : item)),
    );
  }

  function addItem() {
    setItems((prev) => [...prev, { description: "" }]);
  }

  function removeItem(index: number) {
    setItems((prev) =>
      prev.length === 1 ? prev : prev.filter((_, idx) => idx !== index),
    );
  }

  async function handleCreate() {
    setErrorKey(undefined);
    setNotice(undefined);
    if (!branchId) return;
    if (!mechanicId) {
      setErrorKey(isMechanic ? "needMechanic" : "needMechanicAdmin");
      return;
    }
    const selectedSourceWorkOrderId = sourceWorkOrderId.trim();
    if (!selectedSourceWorkOrderId) {
      setErrorKey("needWorkOrder");
      return;
    }
    const candidates = items
      .map((item) => ({ description: item.description.trim() }))
      .filter((item) => item.description.length > 0);
    if (candidates.length === 0) {
      setErrorKey("needItem");
      return;
    }
    const cleanItems = candidates.map((item) => ({
      work_order_id: selectedSourceWorkOrderId,
      description: item.description,
    }));
    setWriteState("busy");
    try {
      const body: CreateDailyPlanRequest = {
        branch_id: branchId,
        mechanic_id: mechanicId,
        plan_date: planDate,
        items: cleanItems,
      };
      const response = await api.POST("/api/daily-work-plans", { body });
      if (!response.data) {
        throw new Error("create daily plan response missing data");
      }
      setPlan(response.data);
      setNotice(ko.dailyPlan.createSuccess);
      setWriteState("idle");
      // Object -> queue: surface the just-created plan in the shared list so it
      // is immediately visible (and selectable) alongside the rest of the queue.
      await loadPlans();
    } catch {
      setWriteState("error");
      setErrorKey("createFailed");
    }
  }

  async function handleRequestReview() {
    if (!plan?.id) return;
    await runTransition(
      () =>
        api.POST("/api/daily-work-plans/{planId}/request-review", {
          params: { path: { planId: plan.id ?? "" } },
        }),
      "requestSuccess",
      "requestFailed",
    );
  }

  async function handleReview(decision: DailyPlanStatus) {
    if (!plan?.id) return;
    await runTransition(
      () =>
        api.POST("/api/daily-work-plans/{planId}/review", {
          params: { path: { planId: plan.id ?? "" } },
          body: {
            decision,
            memo: reviewMemo.trim() || undefined,
          },
        }),
      decision === "APPROVED" ? "approveSuccess" : "rejectSuccess",
      "reviewFailed",
    );
  }

  async function handleConfirm() {
    if (!plan?.id) return;
    await runTransition(
      () =>
        api.POST("/api/daily-work-plans/{planId}/confirm", {
          params: { path: { planId: plan.id ?? "" } },
        }),
      "confirmSuccess",
      "confirmFailed",
    );
  }

  async function runTransition(
    call: () => Promise<{ data?: DailyPlanSummary }>,
    successKey: keyof typeof ko.dailyPlan,
    failureKey: string,
  ) {
    setErrorKey(undefined);
    setNotice(undefined);
    setWriteState("busy");
    try {
      const response = await call();
      if (!response.data) {
        throw new Error("daily plan transition response missing data");
      }
      setPlan(response.data);
      setReviewMemo("");
      setNotice(ko.dailyPlan[successKey] as string);
      setWriteState("idle");
      // Reflect the new status in the shared queue (e.g. DRAFT -> REQUESTED).
      await loadPlans();
    } catch {
      setWriteState("error");
      setErrorKey(failureKey);
    }
  }

  const status = plan?.status;
  const busy = writeState === "busy";

  return (
    <>
      <PageHeader
        title={ko.dailyPlan.title}
        description={ko.dailyPlan.description}
      />
      <div className="grid gap-5 max-w-3xl">
        {canRequest ? (
          <Card className="grid gap-4">
            <h2 className="text-lg font-semibold text-ink">
              {ko.dailyPlan.createTitle}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <label
                  className="text-sm font-medium text-steel"
                  htmlFor="plan-mechanic"
                >
                  {isMechanic
                    ? ko.dailyPlan.mechanic
                    : ko.dailyPlan.mechanicAdmin}
                </label>
                <Select
                  id="plan-mechanic"
                  value={mechanicId}
                  onChange={(event) => {
                    setMechanicId(event.currentTarget.value);
                  }}
                >
                  <option value="">
                    {isMechanic
                      ? ko.dailyPlan.mechanicPlaceholder
                      : ko.dailyPlan.mechanicAdminPlaceholder}
                  </option>
                  {mechanics.map((mechanic) => (
                    <option key={mechanic.id} value={mechanic.id}>
                      {mechanic.display_name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-2">
                <label
                  className="text-sm font-medium text-steel"
                  htmlFor="plan-date"
                >
                  {ko.dailyPlan.planDate}
                </label>
                <Input
                  id="plan-date"
                  type="date"
                  value={planDate}
                  onChange={(event) => {
                    setPlanDate(event.currentTarget.value);
                  }}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <span className="text-sm font-medium text-steel">
                {ko.dailyPlan.items}
              </span>
              <div className="grid gap-2 rounded-md border border-line p-3">
                <label
                  className="text-sm font-medium text-steel"
                  htmlFor="plan-source-work-order"
                >
                  {ko.dailyPlan.sourceWorkOrder}
                </label>
                <Select
                  id="plan-source-work-order"
                  value={sourceWorkOrderId}
                  onChange={(event) => {
                    setSourceWorkOrderId(event.currentTarget.value);
                  }}
                >
                  <option value="">
                    {sourceWorkOrders.length === 0
                      ? ko.dailyPlan.sourceWorkOrderEmpty
                      : ko.dailyPlan.sourceWorkOrderPlaceholder}
                  </option>
                  {sourceWorkOrders.map((workOrder) => (
                    <option key={workOrder.id} value={workOrder.id}>
                      {formatWorkOrderOption(workOrder)}
                    </option>
                  ))}
                </Select>
              </div>
              {items.map((item, index) => (
                <div
                  key={index}
                  className="grid gap-3 rounded-md border border-line p-3"
                >
                  <div className="flex items-end gap-2">
                    <div className="grid flex-1 gap-2">
                      <label
                        className="text-sm font-medium text-steel"
                        htmlFor={`plan-item-description-${String(index)}`}
                      >
                        {ko.dailyPlan.itemDescription} {String(index + 1)}
                      </label>
                      <Input
                        id={`plan-item-description-${String(index)}`}
                        value={item.description}
                        placeholder={ko.dailyPlan.itemPlaceholder}
                        onChange={(event) => {
                          setItemDescription(index, event.currentTarget.value);
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${ko.dailyPlan.removeItem} ${String(index + 1)}`}
                      disabled={items.length === 1}
                      onClick={() => {
                        removeItem(index);
                      }}
                    >
                      <Trash2 aria-hidden="true" size={16} />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-fit"
                onClick={addItem}
              >
                <Plus aria-hidden="true" size={14} />
                {ko.dailyPlan.addItem}
              </Button>
            </div>

            <Button type="button" disabled={busy} onClick={() => void handleCreate()}>
              {busy && !plan ? ko.dailyPlan.creating : ko.dailyPlan.create}
            </Button>
          </Card>
        ) : null}

        <Card className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-ink">
              {ko.dailyPlan.queueTitle}
            </h2>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void loadPlans()}
            >
              {ko.dailyPlan.refresh}
            </Button>
          </div>
          {plans.length === 0 ? (
            <p className="text-sm text-steel">{ko.dailyPlan.queueEmpty}</p>
          ) : (
            <ul className="grid gap-2">
              {plans.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-line p-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-ink">
                      {entry.plan_date}
                    </span>
                    {entry.status ? (
                      <Badge aria-label={ko.dailyPlan.status}>
                        {ko.dailyPlan.statuses[entry.status]}
                      </Badge>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-current={entry.id === plan?.id ? "true" : undefined}
                    onClick={() => {
                      setPlan(entry);
                      if (entry.mechanic_id) setMechanicId(entry.mechanic_id);
                      if (entry.plan_date) setPlanDate(entry.plan_date);
                    }}
                  >
                    {ko.dailyPlan.open}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {plan ? (
          <Card className="grid gap-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-ink">
                {ko.dailyPlan.statusLabel}
              </h2>
              {status ? (
                <Badge aria-label={ko.dailyPlan.status}>
                  {ko.dailyPlan.statuses[status]}
                </Badge>
              ) : null}
            </div>

            {plan.items?.length ? (
              <section className="grid gap-2 rounded-md border border-line p-3">
                <h3 className="text-base font-semibold text-ink">
                  {ko.dailyPlan.linkedWorkOrders}
                </h3>
                <ul className="grid gap-2">
                  {plan.items.map((item, index) => (
                    <li
                      key={`${item.work_order_id ?? "item"}-${String(index)}`}
                      className="text-sm text-steel"
                    >
                      {formatDailyPlanItem(item)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {status === "DRAFT" && canRequest ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void handleRequestReview()}
              >
                {busy ? ko.dailyPlan.requesting : ko.dailyPlan.requestReview}
              </Button>
            ) : null}

            {status === "REQUESTED" && canReview ? (
              <div className="grid gap-3 rounded-md border border-line p-3">
                <h3 className="text-base font-semibold text-ink">
                  {ko.dailyPlan.review}
                </h3>
                <Textarea
                  aria-label={ko.dailyPlan.reviewMemo}
                  placeholder={ko.dailyPlan.reviewMemoPlaceholder}
                  rows={2}
                  className="min-h-9"
                  value={reviewMemo}
                  onChange={(event) => {
                    setReviewMemo(event.currentTarget.value);
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleReview("APPROVED")}
                  >
                    {busy ? ko.dailyPlan.reviewing : ko.dailyPlan.approve}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void handleReview("REJECTED")}
                  >
                    {ko.dailyPlan.reject}
                  </Button>
                </div>
              </div>
            ) : null}

            {status === "APPROVED" && canRequest ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirm()}
              >
                {busy ? ko.dailyPlan.confirming : ko.dailyPlan.confirm}
              </Button>
            ) : null}
          </Card>
        ) : (
          <Card>
            <p className="text-sm text-steel">{ko.dailyPlan.noPlan}</p>
          </Card>
        )}

        {notice ? (
          <p role="status" className="text-sm font-medium text-brand-teal">
            {notice}
          </p>
        ) : null}
        {errorKey ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.dailyPlan[errorKey as keyof typeof ko.dailyPlan] as string}
          </p>
        ) : null}
      </div>
    </>
  );
}
