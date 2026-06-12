import type { components } from "@maintenance/api-client-ts";

export type WorkOrderSummary = components["schemas"]["WorkOrderSummary"];
export type WorkOrderListItem = components["schemas"]["WorkOrderListItem"];
export type WorkOrderListPage = components["schemas"]["WorkOrderListPage"];
export type CreateWorkOrderRequest =
  components["schemas"]["CreateWorkOrderRequest"];
export type EquipmentLookupResponse =
  components["schemas"]["EquipmentLookupResponse"];
export type KpiMetric = components["schemas"]["KpiMetric"];
export type KpiReport = components["schemas"]["KpiReport"];
export type KpiRollup = components["schemas"]["KpiRollup"];
export type KpiRollupScope = components["schemas"]["KpiRollupScope"];
export type UnavailableMetric = components["schemas"]["UnavailableMetric"];
export type TokenPairResponse = components["schemas"]["TokenPairResponse"];
export type MessengerThreadKind =
  components["schemas"]["MessengerThreadKind"];
export type MessengerThreadSummary =
  components["schemas"]["MessengerThreadSummary"];
export type MessengerThreadListResponse =
  components["schemas"]["MessengerThreadListResponse"];
export type MessengerMessageSummary =
  components["schemas"]["MessengerMessageSummary"];
export type MessengerMessagePage =
  components["schemas"]["MessengerMessagePage"];
export type MessengerMessageListResponse =
  components["schemas"]["MessengerMessageListResponse"];
export type MessengerReadReceiptSummary =
  components["schemas"]["MessengerReadReceiptSummary"];
export type SendMessengerMessageRequest =
  components["schemas"]["SendMessengerMessageRequest"];
export type EvidencePresignRequest =
  components["schemas"]["EvidencePresignRequest"];
export type EvidencePresignResponse =
  components["schemas"]["EvidencePresignResponse"];

export interface EquipmentLookupResult {
  managementNo: string;
  model: string;
  customerName: string;
  siteName: string;
}

export type EquipmentLookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; equipment: EquipmentLookupResult }
  | { status: "notFound" }
  | { status: "error" };
