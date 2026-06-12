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
export type LocationConsentLedgerPage =
  components["schemas"]["LocationConsentLedgerPage"];
export type LocationConsentState =
  components["schemas"]["LocationConsentState"];
export type LocationConsentStatus =
  components["schemas"]["LocationConsentStatus"];

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
