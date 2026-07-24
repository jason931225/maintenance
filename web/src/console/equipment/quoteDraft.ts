/**
 * Quote draft persistence. The contract requires the quote workflow to keep
 * its Idempotency-Key across refresh so a resubmit after a network failure
 * replays (200, replayed:true) instead of double-creating. Draft fields ride
 * along so the operator does not retype after a refresh.
 */

export interface QuoteDraft {
  idempotencyKey: string;
  customerName: string;
  siteReference: string;
  monthlyRate: string;
  durationMonths: string;
}

function storageKey(branchId: string, unitId: string): string {
  return `equipment3r.quote-draft.${branchId}.${unitId}`;
}

/** RFC 4122 UUID: 36 chars, inside the contract's 16..200 key length window. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function loadQuoteDraft(branchId: string, unitId: string): QuoteDraft | undefined {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey(branchId, unitId));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const draft = parsed as Record<string, unknown>;
    if (typeof draft.idempotencyKey !== "string" || draft.idempotencyKey.length < 16) {
      return undefined;
    }
    return {
      idempotencyKey: draft.idempotencyKey,
      customerName: typeof draft.customerName === "string" ? draft.customerName : "",
      siteReference: typeof draft.siteReference === "string" ? draft.siteReference : "",
      monthlyRate: typeof draft.monthlyRate === "string" ? draft.monthlyRate : "",
      durationMonths: typeof draft.durationMonths === "string" ? draft.durationMonths : "",
    };
  } catch {
    return undefined;
  }
}

export function saveQuoteDraft(branchId: string, unitId: string, draft: QuoteDraft): void {
  try {
    window.localStorage.setItem(storageKey(branchId, unitId), JSON.stringify(draft));
  } catch {
    // Storage unavailable (private mode/quota): the draft simply won't survive refresh.
  }
}

export function clearQuoteDraft(branchId: string, unitId: string): void {
  try {
    window.localStorage.removeItem(storageKey(branchId, unitId));
  } catch {
    // Ignore: nothing to clear when storage is unavailable.
  }
}
