import type { components } from "@maintenance/api-client-ts";

export type WorkOrderSummary = components["schemas"]["WorkOrderSummary"];
export type CreateWorkOrderRequest =
  components["schemas"]["CreateWorkOrderRequest"];
export type TokenPairResponse = components["schemas"]["TokenPairResponse"];

export interface EquipmentLookupResult {
  managementNo: string;
  model: string;
  customerName: string;
  siteName: string;
}

export type EquipmentLookupState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "ready"; equipment: EquipmentLookupResult };
