import { useCallback, useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { productionStrings as text } from "../../i18n/production";
import { createProductionApi, type DailyPlan } from "./productionApi";
import type { ProductionCapabilities } from "./productionCapabilities";
import "./production.css";

type Props = {
  api: ConsoleApiClient;
  branchId: string;
  actorId: string | undefined;
  capabilities: ProductionCapabilities;
  /** Changes whenever auth replaces the effective tenant/session. */
  sessionKey: string | undefined;
};

const apiFenceIds = new WeakMap<object, number>();
let nextApiFenceId = 1;

function apiFenceKey(api: ConsoleApiClient): number {
  const reference = api as object;
  const existing = apiFenceIds.get(reference);
  if (existing) return existing;
  const id = nextApiFenceId++;
  apiFenceIds.set(reference, id);
  return id;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function planId(plan: DailyPlan): string | undefined {
  return plan.id;
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function statusLabel(status: DailyPlan["status"]): string {
  if (status && status in text.status) {
    return text.status[status as keyof typeof text.status];
  }
  return text.status.unknown;
}

/**
 * Re-mount synchronously whenever effective authority changes. Effects run too
 * late to fence an old tenant/session's selected plan, error, or busy state.
 */
export function ProductionScreen(props: Props) {
  const capabilityKey = Object.values(props.capabilities).join(":");
  const sessionFence = [
    props.sessionKey ?? "no-session",
    props.branchId,
    props.actorId ?? "no-actor",
    apiFenceKey(props.api),
    capabilityKey,
  ].join(":");
  return <ProductionScreenBody key={sessionFence} {...props} />;
}

function ProductionScreenBody({ api, branchId, actorId, capabilities, sessionKey }: Props) {
  const [plans, setPlans] = useState<DailyPlan[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const operation = useRef<AbortController | undefined>(undefined);
  const reviewMemo = useRef<HTMLTextAreaElement | null>(null);
  const mechanicId = useId();
  const workOrderId = useId();
  const descriptionId = useId();
  const dateId = useId();
  const reviewMemoId = useId();
  const selected = plans.find((plan) => planId(plan) === selectedId);
  const productionApi = useMemo(() => createProductionApi(api), [api]);

  const isCurrent = useCallback((token: number) => generation.current === token, []);
  const replacePlan = useCallback((next: DailyPlan) => {
    if (next.branch_id !== branchId) {
      setPlans([]);
      setSelectedId(undefined);
      return;
    }
    const id = planId(next);
    if (!id) return;
    setPlans((current) => {
      const exists = current.some((plan) => planId(plan) === id);
      return exists ? current.map((plan) => (planId(plan) === id ? next : plan)) : [next, ...current];
    });
    setSelectedId(id);
  }, [branchId]);

  const load = useCallback(async () => {
    if (!capabilities.canRead) {
      setPlans([]);
      setSelectedId(undefined);
      setLoading(false);
      return;
    }
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const token = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const page = await productionApi.list(undefined, controller.signal);
      if (isCurrent(token)) {
        setPlans(page.items.filter((plan) => plan.branch_id === branchId));
      }
    } catch (cause) {
      if (isCurrent(token) && !controller.signal.aborted) setError(message(cause, text.loadError));
    } finally {
      if (isCurrent(token)) setLoading(false);
    }
  }, [branchId, capabilities.canRead, isCurrent, productionApi]);

  useEffect(() => {
    generation.current += 1;
    operation.current?.abort();
    const start = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(start);
      operation.current?.abort();
    };
  }, [branchId, load, sessionKey]);

  const mutate = useCallback(async (work: (signal: AbortSignal) => Promise<DailyPlan>) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const token = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await work(controller.signal);
      if (isCurrent(token)) replacePlan(next);
      return isCurrent(token);
    } catch (cause) {
      if (isCurrent(token) && !controller.signal.aborted) setError(message(cause, text.actionError));
      return false;
    } finally {
      if (isCurrent(token)) setBusy(false);
    }
  }, [isCurrent, replacePlan]);

  const create = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capabilities.canCreate || !actorId) return;
    const data = new FormData(event.currentTarget);
    const applied = await mutate((signal) => productionApi.create({
      branch_id: branchId,
      mechanic_id: formText(data, "mechanic_id"),
      plan_date: formText(data, "plan_date"),
      items: [{ work_order_id: formText(data, "work_order_id"), description: formText(data, "description").trim() }],
    }, signal));
    if (applied) event.currentTarget.reset();
  };

  const transition = async (action: "request" | "approve" | "reject" | "confirm") => {
    const id = selected && planId(selected);
    if (!id) return;
    if (action === "request" && capabilities.canRequestReview) {
      await mutate((signal) => productionApi.requestReview(id, signal));
    } else if (action === "confirm" && capabilities.canConfirm) {
      await mutate((signal) => productionApi.confirm(id, signal));
    } else if ((action === "approve" || action === "reject") && capabilities.canReview) {
      const memo = reviewMemo.current?.value.trim();
      await mutate((signal) => productionApi.review(id, { decision: action === "approve" ? "APPROVED" : "REJECTED", ...(memo ? { memo } : {}) }, signal));
    }
  };

  if (!capabilities.canRead) {
    return <main className="production"><section className="production__panel" aria-labelledby="production-title"><h1 id="production-title">{text.title}</h1><p role="status">{text.denied}</p></section></main>;
  }

  return <main className="production" aria-busy={loading || busy}>
    <section className="production__panel" aria-labelledby="production-title">
      <header><h1 id="production-title">{text.title}</h1><p>{text.subtitle}</p></header>
      {error && <div className="production__alert" role="alert"><span>{error}</span><button type="button" onClick={() => { void load(); }}>{text.retry}</button></div>}
      {loading ? <p role="status">{text.loading}</p> : <ul className="production__list" aria-label={text.planList}>{plans.length ? plans.map((plan) => {
        const id = planId(plan);
        return id ? <li key={id}><button className={id === selectedId ? "production__plan production__plan--selected" : "production__plan"} type="button" aria-pressed={id === selectedId} onClick={() => { setSelectedId(id); }}><span>{plan.plan_date}</span><strong>{statusLabel(plan.status)}</strong></button></li> : null;
      }) : <li role="status">{text.empty}</li>}</ul>}
      {capabilities.canCreate && actorId && <form className="production__form" onSubmit={(event) => void create(event)}><h2>{text.create}</h2><p>{text.createHint}</p><label htmlFor={mechanicId}>{text.mechanic}<input id={mechanicId} name="mechanic_id" defaultValue={actorId} required /></label><label htmlFor={dateId}>{text.planDate}<input id={dateId} name="plan_date" type="date" required /></label><label htmlFor={workOrderId}>{text.workOrder}<input id={workOrderId} name="work_order_id" required /></label><label htmlFor={descriptionId}>{text.description}<textarea id={descriptionId} name="description" maxLength={500} required /></label><button type="submit" disabled={busy}>{text.create}</button></form>}
    </section>
    <section className="production__panel" aria-live="polite" aria-label={text.detail}>
      {!selected ? <p>{text.select}</p> : <><header><h2>{selected.plan_date}</h2><p>{statusLabel(selected.status)}</p></header><dl className="production__details"><dt>{text.mechanic}</dt><dd>{selected.mechanic_id}</dd><dt>{text.branch}</dt><dd>{selected.branch_id}</dd></dl><h3>{text.items}</h3><ol className="production__items">{selected.items?.map((item) => <li key={`${String(item.sort_order)}-${item.work_order_id ?? item.description}`}><strong>{item.request_no ?? item.management_no ?? text.unlinked}</strong><span>{item.description}</span></li>)}</ol>{selected.status === "DRAFT" && capabilities.canRequestReview && <button type="button" disabled={busy} onClick={() => void transition("request")}>{text.requestReview}</button>}{selected.status === "REQUESTED" && capabilities.canReview && <div className="production__review"><label htmlFor={reviewMemoId}>{text.reviewMemo}<textarea ref={reviewMemo} id={reviewMemoId} maxLength={500} /></label><div><button type="button" disabled={busy} onClick={() => void transition("approve")}>{text.approve}</button><button className="production__danger" type="button" disabled={busy} onClick={() => void transition("reject")}>{text.reject}</button></div></div>}{selected.status === "APPROVED" && capabilities.canConfirm && <button type="button" disabled={busy} onClick={() => void transition("confirm")}>{text.confirm}</button>}</>}
    </section>
  </main>;
}
