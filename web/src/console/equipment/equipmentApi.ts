/**
 * CAP-EQUIPMENT-3R-PILOT transport — implements the shared design contract
 * verbatim (`/api/v1/equipment-3r`, camelCase DTO field names, the
 * `{"error":{"code","message"}}` envelope, `Idempotency-Key` on quote
 * creation). The backend lane builds the same contract in parallel; any
 * deviation here is a defect against that contract, not a style choice.
 *
 * This module adapts the shared generated client to its small console-facing
 * view model; it never owns bearer handling or raw fetch transport.
 */
import { createConsoleApiClient, type ConsoleApiClient } from "../../api/client";
import { getEvidenceObjectDetail, listEvidenceObjects } from "../evidence/evidenceApi";

export type UnitAvailability =
  | "AVAILABLE"
  | "RESERVED"
  | "ON_RENT"
  | "IN_ASSESSMENT"
  | "IN_REPAIR"
  | "IN_REFURBISHMENT"
  | "FOR_SALE"
  | "SOLD";

export type CaseStatus =
  | "QUOTED"
  | "APPROVED"
  | "DECLINED"
  | "DISPATCHED"
  | "HANDED_OVER"
  | "RETURNED"
  | "CLOSED";

export type DispositionKind = "REPAIR" | "REFURBISH" | "RESALE" | "REDEPLOY";
export type DispositionStatus = "OPEN" | "COMPLETED";
export type InspectionOutcome = "PASS" | "MAINTENANCE_PERFORMED";
export type ConditionGrade = "A" | "B" | "C" | "D";
export type ApprovalDecision = "APPROVED" | "DECLINED";

export interface UnitView {
  id: string;
  serialNo: string;
  modelName: string;
  capacityClass: string;
  availability: UnitAvailability;
  acquisitionCostMinor: number;
  branchId: string;
}

export interface UnitDetailView extends UnitView {
  activeCaseId: string | null;
  openDispositionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseView {
  id: string;
  unitId: string;
  status: CaseStatus;
  customerName: string;
  siteReference: string;
  monthlyRateMinor: number;
  durationMonths: number;
  currencyCode: string;
  branchId: string;
  replayed?: boolean;
}

export interface CaseApprovalView {
  decision: ApprovalDecision;
  reason: string | null;
  decidedBy: string;
  decidedAt: string;
}

export interface CaseDispatchView {
  carrierName: string;
  vehicleReference: string;
  dispatchedAt: string;
}

export interface CaseHandoverView {
  recipientName: string;
  evidenceReference: string;
  handedOverAt: string;
}

export interface CaseAssessmentView {
  conditionGrade: ConditionGrade;
  findings: string;
  disposition: DispositionKind;
  assessedBy: string;
  assessedAt: string;
}

export interface InspectionView {
  id: string;
  caseId: string;
  outcome: InspectionOutcome;
  findings: string;
  maintenanceNote: string | null;
  inspectedBy: string;
  inspectedAt: string;
}

export interface CaseDetailView extends CaseView {
  approval: CaseApprovalView | null;
  dispatch: CaseDispatchView | null;
  handover: CaseHandoverView | null;
  returnedAt: string | null;
  assessment: CaseAssessmentView | null;
  dispositionId: string | null;
  inspections: InspectionView[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DispositionView {
  id: string;
  unitId: string;
  caseId: string;
  kind: DispositionKind;
  status: DispositionStatus;
  costMinor: number | null;
  saleAmountMinor: number | null;
  buyerName: string | null;
  completedBy: string | null;
  completedAt: string | null;
}

export interface HistoryEntry {
  aggregateKind: "unit" | "case" | "disposition";
  aggregateId: string;
  transition: string;
  actorId: string;
  occurredAt: string;
}

export interface RegisterUnitInput {
  branchId: string;
  serialNo: string;
  modelName: string;
  capacityClass: string;
  acquisitionCostMinor: number;
}

export interface CreateRentalCaseInput {
  branchId: string;
  unitId: string;
  customerName: string;
  siteReference: string;
  monthlyRateMinor: number;
  durationMonths: number;
  currencyCode: "KRW";
}

export interface ApprovalInput {
  decision: ApprovalDecision;
  reason?: string;
}

export interface DispatchInput {
  carrierName: string;
  vehicleReference: string;
}

export interface HandoverInput {
  recipientName: string;
  evidenceId: string;
  handedOverAt: string;
}
export interface HandoverEvidenceOption { id: string; label: string; }

export interface InspectionInput {
  outcome: InspectionOutcome;
  findings: string;
  maintenanceNote?: string;
}

export interface ReturnInput {
  returnedAt: string;
}

export interface AssessmentInput {
  conditionGrade: ConditionGrade;
  findings: string;
  disposition: DispositionKind;
}

/** REPAIR/REFURBISH require costMinor; RESALE requires saleAmountMinor + buyerName. */
export type CompletionInput =
  | { costMinor: number }
  | { saleAmountMinor: number; buyerName: string };

export class EquipmentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EquipmentApiError";
  }
}

function requireData<T>(response: { data?: T; error?: unknown; response: Response }): T {
  if (response.data !== undefined) return response.data;
  const envelope = response.error && typeof response.error === "object" && "error" in response.error
    ? (response.error as { error?: { code?: unknown; message?: unknown } }).error
    : undefined;
  const message = typeof envelope?.message === "string"
    ? envelope.message
    : `equipment-3r request failed (${String(response.response.status)})`;
  throw new EquipmentApiError(message, response.response.status, typeof envelope?.code === "string" ? envelope.code : undefined);
}

/** Equipment-3R adapter over the shared generated/authenticated transport. */
export function createEquipmentApi(api: ConsoleApiClient | string | undefined) {
  // Legacy callers/tests may still provide a token. They are routed through
  // the shared client immediately; equipment never owns request transport.
  const client = typeof api === "string" || api === undefined ? createConsoleApiClient(api) : api;
  return {
    registerUnit: (input: RegisterUnitInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/units", { body: input, signal }).then(requireData<UnitView>),
    listUnits: (signal?: AbortSignal) =>
      client.GET("/api/v1/equipment-3r/units", { signal }).then(requireData<UnitView[]>),
    getUnit: (unitId: string, signal?: AbortSignal) =>
      client.GET("/api/v1/equipment-3r/units/{unit_id}", { params: { path: { unit_id: unitId } }, signal }).then(requireData<UnitDetailView>),
    unitHistory: (unitId: string, signal?: AbortSignal) =>
      client.GET("/api/v1/equipment-3r/units/{unit_id}/history", { params: { path: { unit_id: unitId } }, signal }).then(requireData<HistoryEntry[]>),
    createRentalCase: (input: CreateRentalCaseInput, idempotencyKey: string, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/rental-cases", { body: input, headers: { "Idempotency-Key": idempotencyKey }, signal }).then(requireData<CaseView>),
    listRentalCases: (signal?: AbortSignal) =>
      client.GET("/api/v1/equipment-3r/rental-cases", { signal }).then(requireData<CaseView[]>),
    getRentalCase: (caseId: string, signal?: AbortSignal) =>
      client.GET("/api/v1/equipment-3r/rental-cases/{case_id}", { params: { path: { case_id: caseId } }, signal }).then(requireData<CaseDetailView>),
    approval: (caseId: string, input: ApprovalInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/rental-cases/{case_id}/approval", { params: { path: { case_id: caseId } }, body: input, signal }).then(requireData<CaseView>),
    dispatch: (caseId: string, input: DispatchInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/rental-cases/{case_id}/dispatch", { params: { path: { case_id: caseId } }, body: input, signal }).then(requireData<CaseView>),
    handover: (caseId: string, input: HandoverInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/rental-cases/{case_id}/handover", { params: { path: { case_id: caseId } }, body: { recipientName: input.recipientName, evidenceReference: input.evidenceId, handedOverAt: input.handedOverAt }, signal }).then(requireData<CaseView>),
    listHandoverEvidence: async (): Promise<HandoverEvidenceOption[]> => {
      const summaries = await listEvidenceObjects(client);
      const details = await Promise.all(summaries
        .filter((item) => item.admissibility === "ADMISSIBLE" && !item.disposed)
        .map((item) => getEvidenceObjectDetail(client, item.id)));
      return details
        .filter((item) => item.copies.some((copy) => copy.kind === "ORIGINAL" && copy.wormStatus === "VERIFIED"))
        .map((item) => ({ id: item.id, label: `${item.code} — ${item.title}` }));
    },
    recordInspection: (caseId: string, input: InspectionInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/rental-cases/{case_id}/inspections", { params: { path: { case_id: caseId } }, body: input, signal }).then(requireData<InspectionView>),
    recordReturn: (caseId: string, input: ReturnInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/rental-cases/{case_id}/return", { params: { path: { case_id: caseId } }, body: input, signal }).then(requireData<CaseView>),
    assessment: (caseId: string, input: AssessmentInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/rental-cases/{case_id}/assessment", { params: { path: { case_id: caseId } }, body: input, signal }).then(requireData<CaseDetailView>),
    completeDisposition: (dispositionId: string, input: CompletionInput, signal?: AbortSignal) =>
      client.POST("/api/v1/equipment-3r/dispositions/{disposition_id}/completion", { params: { path: { disposition_id: dispositionId } }, body: input, signal }).then(requireData<DispositionView>),
  };
}

export type EquipmentApi = ReturnType<typeof createEquipmentApi>;
