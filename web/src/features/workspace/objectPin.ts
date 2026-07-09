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

function statusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("status" in error && typeof error.status === "number") return error.status;
  if ("response" in error) {
    const response = error.response;
    if (response instanceof Response) return response.status;
    if (response && typeof response === "object" && "status" in response && typeof response.status === "number") {
      return response.status;
    }
  }
  return undefined;
}

function dataOrNoPin<T>(result: ApiResult<T>): T | null {
  if (result.data !== undefined) return result.data;
  if (isNoPinStatus(result.response.status)) return null;
  throw new Error(`Pinned object fetch failed with HTTP ${String(result.response.status)}`);
}

function rethrowUnlessNoPin(error: unknown): null {
  const status = statusFromError(error);
  if (status !== undefined && isNoPinStatus(status)) return null;
  throw error;
}

async function fetchOrgPin(
  api: ConsoleApiClient,
  branchId: string,
): Promise<PinnedObject | null> {
  let branch;
  try {
    const response = await api.GET("/api/v1/branches/{id}", {
      params: { path: { id: branchId } },
    });
    branch = dataOrNoPin(response);
  } catch (error) {
    branch = rethrowUnlessNoPin(error);
  }
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
  let detail;
  try {
    const response = await api.GET("/api/v1/support/tickets/{id}", {
      params: { path: { id: ticketId } },
    });
    detail = dataOrNoPin(response);
  } catch (error) {
    detail = rethrowUnlessNoPin(error);
  }
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
  let wo;
  try {
    const response = await api.GET("/api/v1/work-orders/{workOrderId}", {
      params: { path: { workOrderId } },
    });
    wo = dataOrNoPin(response);
  } catch (error) {
    wo = rethrowUnlessNoPin(error);
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
    const response = await api.GET("/api/messenger/members/{userId}", {
      params: { path: { userId }, query: { branch_id: branchId } },
    });
    member = dataOrNoPin(response);
  } catch (error) {
    member = rethrowUnlessNoPin(error);
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
