import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { objectRegistry, workOrderCode } from "../../lib/objectRegistry";
import { priorityLabel, safeLabel } from "../../lib/utils";
import type { PinKind, PinnedObject } from "./types";

/**
 * Fetch the live summary a pin panel renders (UI-M2a): opening an object chip
 * pins a panel populated from the real API, not a stale row snapshot. Returns
 * `null` when the object is unknown/forbidden — deny-by-omission, so an
 * unauthorized reference never pins (nothing to render).
 *
 * Person is the audited case: it reads the non-admin branch directory
 * (`/api/messenger/members/{user_id}`), which records a `person.view` audit
 * event for a non-self view (열람 — 기록 남음) server-side. The fetch itself is
 * therefore the audit trigger — the client makes no audit call of its own.
 *
 * ponytail: work-order/support/org live-pin bodies are follow-ons — their chips
 * already resolve and route via the object registry (AC1/AC5); only the pinned
 * detail body for those kinds is deferred. Add a case here per kind.
 */
export async function fetchPinnedObject(
  api: ConsoleApiClient,
  kind: PinKind,
  args: { id: string; code: string; branchId: string | undefined },
): Promise<PinnedObject | null> {
  if (kind === "person") return fetchPersonPin(api, args.id, args.branchId);
  if (kind === "workOrder") return fetchWorkOrderPin(api, args.id);
  return null;
}

async function fetchWorkOrderPin(
  api: ConsoleApiClient,
  workOrderId: string,
): Promise<PinnedObject | null> {
  let wo;
  try {
    const response = await api.GET("/api/v1/work-orders/{workOrderId}", {
      params: { path: { workOrderId } },
    });
    wo = response.data;
  } catch {
    return null;
  }
  if (!wo) return null;

  const code = workOrderCode(wo.request_no);
  return {
    kind: "workOrder",
    code,
    title: `${safeLabel(wo.customer.name)} · ${safeLabel(wo.equipment.model, wo.equipment.equipment_no)}`,
    fields: [
      { label: ko.console.workspace.field.status, value: ko.status[wo.status] },
      { label: ko.console.workspace.field.priority, value: priorityLabel(wo.priority) },
    ],
    href: objectRegistry.workOrder.route({ id: workOrderId, code }),
  };
}

async function fetchPersonPin(
  api: ConsoleApiClient,
  userId: string,
  branchId: string | undefined,
): Promise<PinnedObject | null> {
  if (!branchId) return null;
  let member;
  try {
    const response = await api.GET("/api/messenger/members/{user_id}", {
      params: { path: { user_id: userId }, query: { branch_id: branchId } },
    });
    member = response.data;
  } catch {
    return null;
  }
  // A forbidden/not-found target leaves `data` undefined → no pin
  // (deny-by-omission); the audit was rolled back server-side.
  if (!member) return null;
  return {
    kind: "person",
    code: userId,
    title: safeLabel(member.display_name),
    fields: [],
    href: objectRegistry.person.route({ id: userId }),
  };
}
