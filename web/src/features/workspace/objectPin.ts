import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { objectRegistry, workOrderCode } from "../../lib/objectRegistry";
import { priorityLabel, safeLabel } from "../../lib/utils";
import { statusLabel as supportStatusLabel } from "../support/support-format";
import type { PinKind, PinnedObject } from "./types";

/**
 * Fetch the live summary a pin panel renders (UI-M2a): opening an object chip
 * pins a panel populated from the real API, not a stale row snapshot. Returns
 * `null` when the object is unknown/forbidden — deny-by-omission, so an
 * unauthorized reference never pins (nothing to render).
 *
 * Person is the audited case: it reads the non-admin branch directory
 * (`/api/messenger/members/{userId}`), which records a `person.view` audit
 * event for a non-self view (열람 — 기록 남음) server-side. The fetch itself is
 * therefore the audit trigger — the client makes no audit call of its own.
 * work-order, support, and org-unit read their own detail endpoints; any other
 * `PinKind` (approval/dailyPlan/conversation/attendance) has no M2a detail
 * fetch yet and renders from its pinned snapshot.
 */
export const FETCHABLE_PIN_KINDS: ReadonlySet<PinKind> = new Set<PinKind>([
  "person",
  "workOrder",
  "support",
  "org",
]);

export async function fetchPinnedObject(
  api: ConsoleApiClient,
  kind: PinKind,
  args: { id: string; code: string; branchId: string | undefined },
): Promise<PinnedObject | null> {
  if (kind === "person") return fetchPersonPin(api, args.id, args.branchId);
  if (kind === "workOrder") return fetchWorkOrderPin(api, args.id);
  if (kind === "support") return fetchSupportPin(api, args.id);
  if (kind === "org") return fetchOrgPin(api, args.id);
  return null;
}

type ApiResult<T> = { data?: T; response: Response };

function isNoPinStatus(status: number): boolean {
  return status === 403 || status === 404;
}

function dataOrNoPin<T>(result: ApiResult<T>): T | null {
  if (result.data !== undefined) return result.data;
  if (isNoPinStatus(result.response.status)) return null;
  throw new Error(`Pinned object fetch failed with HTTP ${String(result.response.status)}`);
}

async function fetchOrgPin(
  api: ConsoleApiClient,
  branchId: string,
): Promise<PinnedObject | null> {
  const branch = dataOrNoPin(
    await api.GET("/api/v1/branches/{id}", { params: { path: { id: branchId } } }),
  );
  if (!branch) return null;

  return {
    kind: "org",
    code: branchId,
    title: safeLabel(branch.name),
    fields: [],
    href: objectRegistry.org.route({ id: branchId }),
  };
}

async function fetchSupportPin(
  api: ConsoleApiClient,
  ticketId: string,
): Promise<PinnedObject | null> {
  const detail = dataOrNoPin(
    await api.GET("/api/v1/support/tickets/{id}", { params: { path: { id: ticketId } } }),
  );
  const ticket = detail?.ticket;
  if (!ticket) return null;

  const code = `CS-${ticketId}`;
  return {
    kind: "support",
    code,
    title: safeLabel(ticket.title),
    fields: [{ label: ko.console.workspace.field.status, value: supportStatusLabel(ticket.status) }],
    href: objectRegistry.support.route({ id: ticketId, code }),
  };
}

async function fetchWorkOrderPin(
  api: ConsoleApiClient,
  workOrderId: string,
): Promise<PinnedObject | null> {
  const wo = dataOrNoPin(
    await api.GET("/api/v1/work-orders/{workOrderId}", { params: { path: { workOrderId } } }),
  );
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
  // A forbidden/not-found target leaves `data` undefined → no pin
  // (deny-by-omission); the audit was rolled back server-side.
  const member = dataOrNoPin(
    await api.GET("/api/messenger/members/{userId}", {
      params: { path: { userId }, query: { branch_id: branchId } },
    }),
  );
  if (!member) return null;
  return {
    kind: "person",
    code: userId,
    title: safeLabel(member.display_name),
    fields: [],
    href: objectRegistry.person.route({ id: userId }),
  };
}
