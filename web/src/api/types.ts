import type { components } from "@maintenance/api-client-ts";

export type WorkOrderSummary = components["schemas"]["WorkOrderSummary"];
export type WorkOrderListItem = components["schemas"]["WorkOrderListItem"];
export type WorkOrderListPage = components["schemas"]["WorkOrderListPage"];
export type CreateWorkOrderRequest =
  components["schemas"]["CreateWorkOrderRequest"];
export type EquipmentLookupResponse =
  components["schemas"]["EquipmentLookupResponse"];
export type EquipmentSummary = components["schemas"]["EquipmentSummary"];
export type EquipmentStatus = components["schemas"]["EquipmentStatus"];
export type CreateEquipmentRequest =
  components["schemas"]["CreateEquipmentRequest"];
export type UpdateEquipmentRequest =
  components["schemas"]["UpdateEquipmentRequest"];
export type CreateMessengerThreadRequest =
  components["schemas"]["CreateMessengerThreadRequest"];
export type DailyPlanStatus = components["schemas"]["DailyPlanStatus"];
export type DailyPlanSummary = components["schemas"]["DailyPlanSummary"];
export type CreateDailyPlanRequest =
  components["schemas"]["CreateDailyPlanRequest"];
export type KpiMetric = components["schemas"]["KpiMetric"];
export type KpiReport = components["schemas"]["KpiReport"];
export type KpiRollup = components["schemas"]["KpiRollup"];
export type KpiRollupScope = components["schemas"]["KpiRollupScope"];
export type UnavailableMetric = components["schemas"]["UnavailableMetric"];
export type OpsSummary = components["schemas"]["OpsSummary"];
export type OpsFunnel = components["schemas"]["OpsFunnel"];
export type OpsEquipmentStatus = components["schemas"]["OpsEquipmentStatus"];
export type OpsMechanicLoad = components["schemas"]["OpsMechanicLoad"];
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
export type LocationConsentLedgerPage =
  components["schemas"]["LocationConsentLedgerPage"];
export type LocationConsentState =
  components["schemas"]["LocationConsentState"];
export type LocationConsentStatus =
  components["schemas"]["LocationConsentStatus"];
export type SupportTicketStatus =
  components["schemas"]["SupportTicketStatus"];
export type SupportTicketPriority =
  components["schemas"]["SupportTicketPriority"];
export type SupportTicketCategory =
  components["schemas"]["SupportTicketCategory"];
export type SupportTicketOrigin =
  components["schemas"]["SupportTicketOrigin"];
export type SupportTicketSummary =
  components["schemas"]["SupportTicketSummary"];
export type SupportTicketComment =
  components["schemas"]["SupportTicketComment"];
export type SupportTicketDetail =
  components["schemas"]["SupportTicketDetail"];
export type CreateInternalTicketRequest =
  components["schemas"]["CreateInternalTicketRequest"];
export type CustomerIntakeRequest =
  components["schemas"]["CustomerIntakeRequest"];
export type AssignTicketRequest =
  components["schemas"]["AssignTicketRequest"];
export type TransitionTicketRequest =
  components["schemas"]["TransitionTicketRequest"];
export type AddCommentRequest =
  components["schemas"]["AddCommentRequest"];
export type SupportIntakeAck = components["schemas"]["SupportIntakeAck"];

export type Team = components["schemas"]["Team"];
export type UserSummary = components["schemas"]["UserSummary"];
export type CreateUserRequest = components["schemas"]["CreateUserRequest"];
export type UpdateUserRequest = components["schemas"]["UpdateUserRequest"];
export type UpdateSelfProfileRequest =
  components["schemas"]["UpdateSelfProfileRequest"];
export type RegionSummary = components["schemas"]["RegionSummary"];
export type CreateRegionRequest = components["schemas"]["CreateRegionRequest"];
export type BranchSummary = components["schemas"]["BranchSummary"];
export type CreateBranchRequest = components["schemas"]["CreateBranchRequest"];
export type UpdateBranchRequest = components["schemas"]["UpdateBranchRequest"];

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
