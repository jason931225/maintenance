import type { components } from "@maintenance/api-client-ts";

type WorkOrderStatus = components["schemas"]["WorkOrderStatus"];
type PriorityLevel = components["schemas"]["PriorityLevel"];
type WorkOrderListItem = components["schemas"]["WorkOrderListItem"];

export interface WorkOrderFilterState {
  /** Free-text query over request_no / customer / equipment-no (client-side). */
  query: string;
  /** Server-side `status[]` query param ("" = no filter). */
  status: WorkOrderStatus | "";
  /** Server-side `priority[]` query param ("" = no filter). */
  priority: PriorityLevel | "";
}

export const EMPTY_WORK_ORDER_FILTERS: WorkOrderFilterState = {
  query: "",
  status: "",
  priority: "",
};

/**
 * Client-side text match for the free-text query over request_no, customer name,
 * and equipment management/equipment number/model. Case-insensitive substring.
 */
export function matchesWorkOrderQuery(
  workOrder: WorkOrderListItem,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    workOrder.request_no,
    workOrder.customer.name,
    workOrder.equipment.management_no,
    workOrder.equipment.equipment_no,
    workOrder.equipment.model,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return haystack.some((value) => value.includes(q));
}
