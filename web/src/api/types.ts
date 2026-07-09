import type { components } from "@maintenance/api-client-ts";

export type PolicyPermissionResponse =
  components["schemas"]["PolicyPermissionResponse"];
export type PolicyDefaultPermissionResponse =
  components["schemas"]["PolicyDefaultPermissionResponse"];
export type PolicyFeatureResponse =
  components["schemas"]["PolicyFeatureResponse"];
export type SystemPolicyRoleResponse =
  components["schemas"]["SystemPolicyRoleResponse"];
export type PolicyRoleResponse = components["schemas"]["PolicyRoleResponse"];
export type PolicyRoleCatalogResponse =
  components["schemas"]["PolicyRoleCatalogResponse"];
export type PolicyAuditEventResponse =
  components["schemas"]["PolicyAuditEventResponse"];
export type PolicyRoleStatusPreviewResponse =
  components["schemas"]["PolicyRoleStatusPreviewResponse"];
export type CreatePolicyRoleRequest =
  components["schemas"]["CreatePolicyRoleRequest"];
export type UpdatePolicyRoleRequest =
  components["schemas"]["UpdatePolicyRoleRequest"];
export type PolicyRoleTemplateResponse =
  components["schemas"]["PolicyRoleTemplateResponse"];
export type PolicyRoleAssignmentResponse =
  components["schemas"]["PolicyRoleAssignmentResponse"];
export type PolicyAssignmentPreviewResponse =
  components["schemas"]["PolicyAssignmentPreviewResponse"];
export type ReplacePolicyRoleAssignmentsRequest =
  components["schemas"]["ReplacePolicyRoleAssignmentsRequest"];
export type PasskeySummary = components["schemas"]["PasskeySummary"];
export type WorkOrderSummary = components["schemas"]["WorkOrderSummary"];
export type WorkOrderListItem = components["schemas"]["WorkOrderListItem"];
export type WorkOrderDetail = components["schemas"]["WorkOrderDetail"];
export type WorkOrderListPage = components["schemas"]["WorkOrderListPage"];
export type ApprovalItemSource = components["schemas"]["ApprovalItemSource"];
export type ApprovalOntologyContext =
  components["schemas"]["ApprovalOntologyContext"];
export type ApprovalWorkflowContext =
  components["schemas"]["ApprovalWorkflowContext"];
export type ApprovalPolicyContext =
  components["schemas"]["ApprovalPolicyContext"];
export type ApprovalItem = components["schemas"]["ApprovalItem"];
export type ApprovalItemsPage = components["schemas"]["ApprovalItemsPage"];
export type WorkOrderObjectSetLens =
  components["schemas"]["WorkOrderObjectSetLens"];
export type WorkOrderFacetBucket =
  components["schemas"]["WorkOrderFacetBucket"];
export type WorkOrderHistogramBucket =
  components["schemas"]["WorkOrderHistogramBucket"];
export type WorkOrderNamedBucket =
  components["schemas"]["WorkOrderNamedBucket"];
export type CreateWorkOrderRequest =
  components["schemas"]["CreateWorkOrderRequest"];
export type UpdateWorkOrderIntakeRequest =
  components["schemas"]["UpdateWorkOrderIntakeRequest"];
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
export type SubstituteCandidate = components["schemas"]["SubstituteCandidate"];
export type SubstituteCandidatePage =
  components["schemas"]["SubstituteCandidatePage"];
export type SubstituteAssignment =
  components["schemas"]["SubstituteAssignment"];
export type SiteLocationGroup = components["schemas"]["SiteLocationGroup"];
export type EquipmentByLocationPage =
  components["schemas"]["EquipmentByLocationPage"];
export type ArrivalEventPage = components["schemas"]["ArrivalEventPage"];
export type EquipmentListItem = components["schemas"]["EquipmentListItem"];
export type EquipmentListPage = components["schemas"]["EquipmentListPage"];
export type EquipmentTimelineGraph =
  components["schemas"]["EquipmentTimelineGraph"];
export type EquipmentLifecycleEvent =
  components["schemas"]["EquipmentLifecycleEvent"];
export type EquipmentGraphNode = components["schemas"]["EquipmentGraphNode"];
export type EquipmentGraphEdge = components["schemas"]["EquipmentGraphEdge"];
export type ObjectActionCatalogResponse =
  components["schemas"]["ObjectActionCatalogResponse"];
export type ObjectActionDescriptor =
  components["schemas"]["ObjectActionDescriptor"];
export type ObjectActionFieldDescriptor =
  components["schemas"]["ObjectActionFieldDescriptor"];
export type ExecuteObjectActionRequest =
  components["schemas"]["ExecuteObjectActionRequest"];
export type ObjectActionExecutionResponse =
  components["schemas"]["ObjectActionExecutionResponse"];
export type WorkflowStudioCatalogResponse =
  components["schemas"]["WorkflowStudioCatalogResponse"];
export type WorkflowConnectorDescriptor =
  components["schemas"]["WorkflowConnectorDescriptor"];
export type WorkflowTemplateDescriptor =
  components["schemas"]["WorkflowTemplateDescriptor"];
export type WorkflowDefinitionListResponse =
  components["schemas"]["WorkflowDefinitionListResponse"];
export type WorkflowDefinitionResponse =
  components["schemas"]["WorkflowDefinitionResponse"];
export type WorkflowDefinitionHistoryResponse =
  components["schemas"]["WorkflowDefinitionHistoryResponse"];
export type WorkflowDefinitionEventResponse =
  components["schemas"]["WorkflowDefinitionEventResponse"];
export type WorkflowSimulationResponse =
  components["schemas"]["WorkflowSimulationResponse"];
export type WorkflowStepUpRequest =
  components["schemas"]["WorkflowStepUpRequest"];
export type UpdateWorkflowDefinitionRequest =
  components["schemas"]["UpdateWorkflowDefinitionRequest"];
export type CollaborationScopeType =
  components["schemas"]["CollaborationScopeType"];
export type CalendarEventResponse =
  components["schemas"]["CalendarEventResponse"];
export type CalendarEventListResponse =
  components["schemas"]["CalendarEventListResponse"];
export type CreateCalendarEventRequest =
  components["schemas"]["CreateCalendarEventRequest"];
export type PollStatus = components["schemas"]["PollStatus"];
export type PollAnonymity = components["schemas"]["PollAnonymity"];
export type PollResponse = components["schemas"]["PollResponse"];
export type PollListResponse = components["schemas"]["PollListResponse"];
export type CreatePollRequest = components["schemas"]["CreatePollRequest"];
export type VotePollRequest = components["schemas"]["VotePollRequest"];
export type EquipmentSortBy = components["schemas"]["EquipmentSortBy"];
export type UpdateSiteRequest = components["schemas"]["UpdateSiteRequest"];
export type CreateCustomerRequest =
  components["schemas"]["CreateCustomerRequest"];
export type CreatedCustomer = components["schemas"]["CreatedCustomer"];
export type CreateSiteRequest = components["schemas"]["CreateSiteRequest"];
export type CreatedSite = components["schemas"]["CreatedSite"];
export type InspectionScheduleSummary =
  components["schemas"]["InspectionScheduleSummary"];
export type InspectionSchedulePage =
  components["schemas"]["InspectionSchedulePage"];
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
export type DailyPlanListPage = components["schemas"]["DailyPlanListPage"];
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
export type MessengerThreadKind = components["schemas"]["MessengerThreadKind"];
export type MessengerMemberSummary =
  components["schemas"]["MessengerMemberSummary"];
export type MessengerMemberListResponse =
  components["schemas"]["MessengerMemberListResponse"];
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
export type EvidenceStagingPresignRequest =
  components["schemas"]["EvidenceStagingPresignRequest"];
export type EvidenceStagingPresignResponse =
  components["schemas"]["EvidenceStagingPresignResponse"];
export type EvidenceStatusResponse =
  components["schemas"]["EvidenceStatusResponse"];
export type ProcessingStatus = components["schemas"]["ProcessingStatus"];
export type MediaKind = components["schemas"]["MediaKind"];
export type LocationConsentLedgerPage =
  components["schemas"]["LocationConsentLedgerPage"];
export type LocationConsentState =
  components["schemas"]["LocationConsentState"];
export type LocationConsentStatus =
  components["schemas"]["LocationConsentStatus"];
export type SupportTicketStatus = components["schemas"]["SupportTicketStatus"];
export type SupportTicketPriority =
  components["schemas"]["SupportTicketPriority"];
export type SupportTicketCategory =
  components["schemas"]["SupportTicketCategory"];
export type SupportTicketOrigin = components["schemas"]["SupportTicketOrigin"];
export type SupportTicketSummary =
  components["schemas"]["SupportTicketSummary"];
export type SupportTicketComment =
  components["schemas"]["SupportTicketComment"];
export type SupportTicketDetail = components["schemas"]["SupportTicketDetail"];
export type SupportTicketPage = components["schemas"]["SupportTicketPage"];
export type CreateInternalTicketRequest =
  components["schemas"]["CreateInternalTicketRequest"];
export type CustomerIntakeRequest =
  components["schemas"]["CustomerIntakeRequest"];
export type AssignTicketRequest = components["schemas"]["AssignTicketRequest"];
export type TransitionTicketRequest =
  components["schemas"]["TransitionTicketRequest"];
export type AddCommentRequest = components["schemas"]["AddCommentRequest"];
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

export interface AbsenceExitDashboardResponse {
  summary: AbsenceExitSummary;
  alerts: EmployeeAbsenceAlert[];
  exit_cases: EmployeeExitCase[];
}

export interface AbsenceExitSummary {
  open_absence_alerts: number;
  exit_cases_pending_hr: number;
  settlement_needs_source: number;
  settlement_ready: number;
  approval_drafts: number;
  submitted: number;
}

export type EmployeeAbsenceAlertStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "LINKED_EXIT"
  | "RESOLVED";

export type EmployeeExitCaseStatus =
  | "REPORTED"
  | "HR_CONFIRMED"
  | "HQ_CONFIRMED"
  | "SETTLEMENT_READY"
  | "APPROVAL_DRAFTED"
  | "SUBMITTED"
  | "REJECTED"
  | "CANCELLED";

export type EmployeeExitSettlementPackageStatus =
  | "NEEDS_SOURCE"
  | "READY_FOR_APPROVAL"
  | "APPROVAL_DRAFTED"
  | "SUBMITTED";

export type SettlementCertificationStatus = "CERTIFIED" | "UNCERTIFIED_DRAFT";

export interface EmployeeAbsenceAlert {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_number?: string | null;
  company: string;
  org_unit?: string | null;
  worksite_name?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  work_date: string;
  source: string;
  status: EmployeeAbsenceAlertStatus;
  severity: string;
  audience_roles: string[];
  signal_payload: Record<string, unknown>;
  notification_title: string;
  notification_message: string;
  link_href: string;
  exit_case_id?: string | null;
  detected_at: string;
}

export interface ReportEmployeeExitCaseRequest {
  employee_id: string;
  branch_id?: string | null;
  absence_alert_id?: string | null;
  effective_exit_date: string;
  site_manager_note: string;
}

export interface ConfirmEmployeeExitCaseRequest {
  decision?: "CONFIRM" | "REJECT";
  hq_confirmation?: boolean;
  note?: string;
  settlement_input?: ExitSettlementInput;
}

export interface DraftEmployeeExitApprovalRequest {
  submit?: boolean;
  note?: string;
  settlement_input?: ExitSettlementInput;
}

export interface ExitSettlementInput {
  average_wage_period_start: string;
  average_wage_period_end: string;
  average_wage_calendar_days: number;
  average_wage_total_won: number;
  // Monthly 통상임금 (ordinary wage) in won — mandatory on the backend (no serde
  // default) so the statutory 통상임금 floor is never silently skipped.
  monthly_ordinary_wage_won: number;
}

export interface EmployeeExitCase {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_number?: string | null;
  company: string;
  org_unit?: string | null;
  worksite_name?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  absence_alert_id?: string | null;
  status: EmployeeExitCaseStatus;
  effective_exit_date: string;
  site_manager_note: string;
  reported_by: string;
  reported_at: string;
  hr_confirmed_by?: string | null;
  hr_confirmed_at?: string | null;
  hq_confirmed_by?: string | null;
  hq_confirmed_at?: string | null;
  approval_submitted_by?: string | null;
  approval_submitted_at?: string | null;
  settlement_package?: EmployeeExitSettlementPackage | null;
  next_actions: ExitCaseNextAction[];
}

export interface EmployeeExitSettlementPackage {
  id: string;
  status: EmployeeExitSettlementPackageStatus;
  service_days?: number | null;
  average_wage_period_start?: string | null;
  average_wage_period_end?: string | null;
  average_wage_calendar_days?: number | null;
  average_wage_total_won?: number | null;
  average_daily_wage_milliwon?: number | null;
  severance_pay_won?: number | null;
  // 통상임금 (ordinary-wage) statutory basis: the monthly ordinary wage a
  // reviewer signs, the 통상일급 derived from it (209h/8h rule), and the daily
  // wage that actually governed severance = max(average, ordinary). Auditable
  // money trail; digest-bound on the backend.
  monthly_ordinary_wage_won?: number | null;
  ordinary_daily_wage_won?: number | null;
  statutory_daily_wage_milliwon?: number | null;
  missing_source_fields: string[];
  statutory_basis: Record<string, unknown>;
  insurance_loss_payload: Record<string, unknown>;
  approval_payload: Record<string, unknown>;
  // EFFECTIVE certification state — the single source the "산정 초안 — 노무사
  // 검증 전" draft label derives from on every rendering surface.
  certification_status: SettlementCertificationStatus;
  generated_at: string;
  submitted_by?: string | null;
  submitted_at?: string | null;
}

export interface ExitCaseNextAction {
  key: string;
  label: string;
  href: string;
}
export type InquiryTopic = components["schemas"]["InquiryTopic"];
export type InquiryStatus = components["schemas"]["InquiryStatus"];
export type ListingMediaView = components["schemas"]["ListingMediaView"];
export type SalesListingView = components["schemas"]["SalesListingView"];
export type SalesListingPage = components["schemas"]["SalesListingPage"];
export type CustomerInquiryView = components["schemas"]["CustomerInquiryView"];
export type CustomerInquiryPage = components["schemas"]["CustomerInquiryPage"];
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
export type UserPage = components["schemas"]["UserPage"];
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

// Webmail / corporate mail account (B-mail-2). The password is WRITE-ONLY: the
// view never returns it — has_smtp_password / has_imap_password signal whether a
// credential is on file. MailSecurity maps SSL/TLS vs STARTTLS.
export type MailSecurity = components["schemas"]["MailSecurity"];
export type MailAccountView = components["schemas"]["MailAccountView"];
export type ConfigureMailAccountRequest =
  components["schemas"]["ConfigureMailAccountRequest"];
export type MailTestConnectionResult =
  components["schemas"]["MailTestConnectionResult"];
export type SendMailRequest = components["schemas"]["SendMailRequest"];
export type SendMailResult = components["schemas"]["SendMailResult"];
export type MailAddress = components["schemas"]["MailAddress"];
export type MailFolderView = components["schemas"]["MailFolderView"];
export type MailThreadView = components["schemas"]["MailThreadView"];
export type MailThreadDetail = components["schemas"]["MailThreadDetail"];
export type MailMessageView = components["schemas"]["MailMessageView"];
export type MailAttachmentView = components["schemas"]["MailAttachmentView"];
export type MailAttachmentDownload =
  components["schemas"]["MailAttachmentDownload"];

// Integrity engine (#12 / #34): governance findings (review-needed anomalies).
export type GovernanceFinding = components["schemas"]["GovernanceFinding"];
export type FindingStatus = components["schemas"]["FindingStatus"];
export type FindingSeverity = components["schemas"]["FindingSeverity"];
export type TriageFindingRequest =
  components["schemas"]["TriageFindingRequest"];

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

// HR employee directory (not auth users).
export type EmployeeDirectoryItem = components["schemas"]["Employee"];
export type EmployeeDirectoryPage = components["schemas"]["EmployeePage"];
export type EmployeeLifecycleEvent =
  components["schemas"]["EmployeeLifecycleEvent"];
export type EmployeeLifecycleEventPage =
  components["schemas"]["EmployeeLifecycleEventPage"];
export type CreateEmployeeLifecycleEventRequest =
  components["schemas"]["CreateEmployeeLifecycleEventRequest"];
export type EmployeeImportSummary =
  components["schemas"]["EmployeeImportReport"];
export type EmployeeImportPreview =
  components["schemas"]["EmployeeImportPreviewResponse"];
export type EmployeeImportDryRun =
  components["schemas"]["EmployeeImportDryRunSummary"];
export type HrOrgChartResponse = components["schemas"]["HrOrgChartResponse"];
export type LeaveBalancePage = components["schemas"]["LeaveBalancePage"];
export type AttendanceSummaryPage =
  components["schemas"]["AttendanceSummaryPage"];
export type CreateEmployeeAttendanceRecordRequest =
  components["schemas"]["CreateEmployeeAttendanceRecordRequest"];
export type EmployeeAttendanceRecord =
  components["schemas"]["EmployeeAttendanceRecord"];
export type EmployeeAttendanceRecordPage =
  components["schemas"]["EmployeeAttendanceRecordPage"];
export interface HrReadinessSummary {
  imports: {
    runs: number;
    applied_runs: number;
    input_rows: number;
    candidate_rows: number;
    preserved_rows: number;
    ledger_rows: number;
    latest_import_at?: string | null;
  };
  payroll: {
    draft_runs: number;
    blocked_runs: number;
    calculation_enabled_runs: number;
    draft_lines: number;
    payroll_source_rows: number;
    attendance_source_rows: number;
    attendance_event_links: number;
    attendance_material_refs: number;
    gross_pay_source_lines: number;
    net_pay_source_lines: number;
    latest_status?: string | null;
    latest_source_label?: string | null;
    latest_period_start?: string | null;
    latest_period_end?: string | null;
    latest_updated_at?: string | null;
  };
  annual_leave: {
    obligations: number;
    usage_promotion_required: number;
    payout_review_required: number;
    needs_review: number;
    remaining_days: string;
  };
  attendance: {
    durable_events: number;
    self_service_records: number;
    payroll_material_refs: number;
  };
}
export type AttendanceImportPreview =
  components["schemas"]["AttendanceImportPreviewResponse"];
export type AttendanceImportDryRun =
  components["schemas"]["AttendanceImportDryRunSummary"];
export type AttendanceImportApplyReport =
  components["schemas"]["AttendanceImportApplyReport"];
export type AttendanceImportSummaryPage =
  components["schemas"]["AttendanceImportSummaryPage"];

// UI-M3 Overview (통합 개요) — unified action inbox + todos.
export type WorkflowTaskSummary =
  components["schemas"]["WorkflowTaskSummary"];
export type MyDispatchOffer = components["schemas"]["MyDispatchOffer"];
export type AttendanceSummaryItem =
  components["schemas"]["AttendanceSummaryItem"];
export type TodoSummary = components["schemas"]["TodoSummary"];
export type TodoRef = components["schemas"]["TodoRef"];

// UI-M4 전자결재 (approvals on the workflow engine).
export type WorkflowRunListItem =
  components["schemas"]["WorkflowRunListItem"];
export type WorkflowRunDetailResponse =
  components["schemas"]["WorkflowRunDetailResponse"];
export type WorkflowRunDetailRun =
  components["schemas"]["WorkflowRunDetailRun"];
export type WorkflowRunTimelineStep =
  components["schemas"]["WorkflowRunTimelineStep"];
export type DecideWorkflowTaskResponse =
  components["schemas"]["DecideWorkflowTaskResponse"];
