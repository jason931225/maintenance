/**
 * CAP-EQUIPMENT-3R-PILOT transport — implements the shared design contract
 * verbatim (`/api/v1/equipment-3r`, camelCase DTO field names, the
 * `{"error":{"code","message"}}` envelope, `Idempotency-Key` on quote
 * creation). The backend lane builds the same contract in parallel; any
 * deviation here is a defect against that contract, not a style choice.
 *
 * ponytail: raw fetch, not the generated openapi client, because the
 * equipment-3r paths are not in `@maintenance/api-client-ts` yet (openapi.yaml
 * is integrator-owned). Swap to `api.GET/POST` once the client is regenerated.
 */

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
  financeGlPosting: null;
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
  evidenceReference: string;
  handedOverAt: string;
}

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

const API_PREFIX = "/api/v1/equipment-3r";

function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

function envelopeError(payload: unknown, status: number): EquipmentApiError {
  if (payload && typeof payload === "object" && "error" in payload) {
    const body = (payload as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof body?.message === "string") {
      return new EquipmentApiError(
        body.message,
        status,
        typeof body.code === "string" ? body.code : undefined,
      );
    }
  }
  return new EquipmentApiError(`equipment-3r request failed (${String(status)})`, status);
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(
  accessToken: string | undefined,
  method: "GET" | "POST",
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  const response = await fetch(`${apiBaseUrl()}${API_PREFIX}${path}`, {
    method,
    headers,
    credentials: "include",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw envelopeError(payload, response.status);
  return payload as T;
}

/** Equipment-3R transport bound to the session bearer token. */
export function createEquipmentApi(accessToken?: string) {
  return {
    registerUnit: (input: RegisterUnitInput, signal?: AbortSignal) =>
      request<UnitView>(accessToken, "POST", "/units", { body: input, signal }),
    listUnits: (signal?: AbortSignal) =>
      request<UnitView[]>(accessToken, "GET", "/units", { signal }),
    getUnit: (unitId: string, signal?: AbortSignal) =>
      request<UnitDetailView>(accessToken, "GET", `/units/${encodeURIComponent(unitId)}`, { signal }),
    unitHistory: (unitId: string, signal?: AbortSignal) =>
      request<HistoryEntry[]>(accessToken, "GET", `/units/${encodeURIComponent(unitId)}/history`, { signal }),
    createRentalCase: (input: CreateRentalCaseInput, idempotencyKey: string, signal?: AbortSignal) =>
      request<CaseView>(accessToken, "POST", "/rental-cases", {
        body: input,
        headers: { "Idempotency-Key": idempotencyKey },
        signal,
      }),
    listRentalCases: (signal?: AbortSignal) =>
      request<CaseView[]>(accessToken, "GET", "/rental-cases", { signal }),
    getRentalCase: (caseId: string, signal?: AbortSignal) =>
      request<CaseDetailView>(accessToken, "GET", `/rental-cases/${encodeURIComponent(caseId)}`, { signal }),
    approval: (caseId: string, input: ApprovalInput, signal?: AbortSignal) =>
      request<CaseView>(accessToken, "POST", `/rental-cases/${encodeURIComponent(caseId)}/approval`, { body: input, signal }),
    dispatch: (caseId: string, input: DispatchInput, signal?: AbortSignal) =>
      request<CaseView>(accessToken, "POST", `/rental-cases/${encodeURIComponent(caseId)}/dispatch`, { body: input, signal }),
    handover: (caseId: string, input: HandoverInput, signal?: AbortSignal) =>
      request<CaseView>(accessToken, "POST", `/rental-cases/${encodeURIComponent(caseId)}/handover`, { body: input, signal }),
    recordInspection: (caseId: string, input: InspectionInput, signal?: AbortSignal) =>
      request<InspectionView>(accessToken, "POST", `/rental-cases/${encodeURIComponent(caseId)}/inspections`, { body: input, signal }),
    recordReturn: (caseId: string, input: ReturnInput, signal?: AbortSignal) =>
      request<CaseView>(accessToken, "POST", `/rental-cases/${encodeURIComponent(caseId)}/return`, { body: input, signal }),
    assessment: (caseId: string, input: AssessmentInput, signal?: AbortSignal) =>
      request<CaseDetailView>(accessToken, "POST", `/rental-cases/${encodeURIComponent(caseId)}/assessment`, { body: input, signal }),
    completeDisposition: (dispositionId: string, input: CompletionInput, signal?: AbortSignal) =>
      request<DispositionView>(accessToken, "POST", `/dispositions/${encodeURIComponent(dispositionId)}/completion`, { body: input, signal }),
  };
}

export type EquipmentApi = ReturnType<typeof createEquipmentApi>;
