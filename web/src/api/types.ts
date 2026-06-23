import type { components } from "@maintenance/api-client-ts";

export type PasskeySummary = components["schemas"]["PasskeySummary"];
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
export type AssetLifecycleCostSummary =
  components["schemas"]["AssetLifecycleCostSummary"];
export type SubstituteCandidate =
  components["schemas"]["SubstituteCandidate"];
export type SubstituteCandidatePage =
  components["schemas"]["SubstituteCandidatePage"];
export type SubstituteAssignment =
  components["schemas"]["SubstituteAssignment"];
export type SiteLocationGroup = components["schemas"]["SiteLocationGroup"];
export type EquipmentByLocationPage =
  components["schemas"]["EquipmentByLocationPage"];
export type UpdateSiteRequest = components["schemas"]["UpdateSiteRequest"];
export type CreateCustomerRequest =
  components["schemas"]["CreateCustomerRequest"];
export type CreatedCustomer = components["schemas"]["CreatedCustomer"];
export type CreateSiteRequest = components["schemas"]["CreateSiteRequest"];
export type CreatedSite = components["schemas"]["CreatedSite"];
export type InspectionScheduleSummary =
  components["schemas"]["InspectionScheduleSummary"];
export type InspectionCycle = components["schemas"]["InspectionCycle"];
export type CreateInspectionScheduleRequest =
  components["schemas"]["CreateInspectionScheduleRequest"];
export type InspectionRoundOutcome =
  components["schemas"]["InspectionRoundOutcome"];
export type InspectionRoundSummary =
  components["schemas"]["InspectionRoundSummary"];
export type CompleteInspectionRoundRequest =
  components["schemas"]["CompleteInspectionRoundRequest"];
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
export type ArrivalEvent = components["schemas"]["ArrivalEvent"];
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

export type FinancialConfigSnapshot =
  components["schemas"]["FinancialConfigSnapshot"];
export type DepreciationMethod = components["schemas"]["DepreciationMethod"];
export type PurchaseStatus = components["schemas"]["PurchaseStatus"];
export type PurchaseRequestSummary =
  components["schemas"]["PurchaseRequestSummary"];
export type CreatePurchaseRequest =
  components["schemas"]["CreatePurchaseRequest"];
export type PrepareExpenditureRequest =
  components["schemas"]["PrepareExpenditureRequest"];
export type RejectPurchaseRequest =
  components["schemas"]["RejectPurchaseRequest"];
export type RestartPurchaseRequest =
  components["schemas"]["RestartPurchaseRequest"];
export type RentalQuoteSummary = components["schemas"]["RentalQuoteSummary"];
export type CreateRentalQuoteRequest =
  components["schemas"]["CreateRentalQuoteRequest"];
export type CostLedgerEntrySummary =
  components["schemas"]["CostLedgerEntrySummary"];
export type CostLedgerSource = components["schemas"]["CostLedgerSource"];
export type AppendManualCostLedgerRequest =
  components["schemas"]["AppendManualCostLedgerRequest"];
export type QuoteLine = components["schemas"]["QuoteLine"];

// Target due-date change review (work-order dispatch → approvals).
export type TargetChangeRequestSummary =
  components["schemas"]["TargetChangeRequestSummary"];
export type TargetChangeDecision =
  components["schemas"]["TargetChangeDecision"];

// Equipment master-list bulk import (#18 importer surface).
export type RegistryImportReport =
  components["schemas"]["RegistryImportReport"];

// Storefront / sales catalog (#6 KNL forklift storefront).
export type ListingKind = components["schemas"]["ListingKind"];
export type ListingCondition = components["schemas"]["ListingCondition"];
export type ListingType = components["schemas"]["ListingType"];
export type ListingStatus = components["schemas"]["ListingStatus"];
export type InquiryTopic = components["schemas"]["InquiryTopic"];
export type InquiryStatus = components["schemas"]["InquiryStatus"];
export type ListingMediaView = components["schemas"]["ListingMediaView"];
export type SalesListingView = components["schemas"]["SalesListingView"];
export type SalesListingPage = components["schemas"]["SalesListingPage"];
export type CustomerInquiryView =
  components["schemas"]["CustomerInquiryView"];
export type CustomerInquiryPage =
  components["schemas"]["CustomerInquiryPage"];
export type SubmitInquiryRequest =
  components["schemas"]["SubmitInquiryRequest"];
export type CreateListingRequest =
  components["schemas"]["CreateListingRequest"];
export type UpdateListingRequest =
  components["schemas"]["UpdateListingRequest"];
export type UpdateInquiryStatusRequest =
  components["schemas"]["UpdateInquiryStatusRequest"];

export type Team = components["schemas"]["Team"];
export type AccountStatus = components["schemas"]["AccountStatus"];
export type UserSummary = components["schemas"]["UserSummary"];
export type CreateUserRequest = components["schemas"]["CreateUserRequest"];
export type UpdateUserRequest = components["schemas"]["UpdateUserRequest"];
export type UpdateSelfProfileRequest =
  components["schemas"]["UpdateSelfProfileRequest"];
export type RegionSummary = components["schemas"]["RegionSummary"];
export type CreateRegionRequest = components["schemas"]["CreateRegionRequest"];
export type UpdateRegionRequest = components["schemas"]["UpdateRegionRequest"];
export type BranchSummary = components["schemas"]["BranchSummary"];
export type CreateBranchRequest = components["schemas"]["CreateBranchRequest"];
export type UpdateBranchRequest = components["schemas"]["UpdateBranchRequest"];

export interface EquipmentLookupResult {
  managementNo: string;
  model: string;
  customerName: string;
  siteName: string;
  maker: string | null;
  vin: string | null;
  vehicleRegistrationNo: string | null;
}

export type EquipmentLookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; equipment: EquipmentLookupResult }
  | { status: "notFound" }
  | { status: "error" };
