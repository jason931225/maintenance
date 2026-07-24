import type { ConsoleApiClient } from "../../../api/client";
import type { EvidenceObjectDetail } from "../../evidence";

export type RetentionEntry =
  | { state: "ready"; retentionUntil: string | null }
  | { state: "unavailable"; retentionUntil: null };

/** Bounds per-row lifecycle reads when the real evidence register spans pages. */
export const RETENTION_READ_CONCURRENCY = 6;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Evidence retention read was aborted", "AbortError");
}

/**
 * Enriches every rendered record with an explicit lifecycle state. The endpoint
 * is per object, so use a fixed worker pool rather than unbounded Promise.all;
 * every non-abort failure becomes a visible unavailable state, never a silent
 * omitted map entry.
 */
export async function readEvidenceRetentions(
  api: ConsoleApiClient,
  rows: EvidenceObjectDetail[],
  signal: AbortSignal,
): Promise<Map<string, RetentionEntry>> {
  const entries = new Map<string, RetentionEntry>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      if (nextIndex >= rows.length) return;
      const row = rows[nextIndex];
      nextIndex += 1;
      try {
        const { data, response } = await api.GET("/api/v1/lifecycles/{objectType}/{objectId}", {
          params: { path: { objectType: "evidence_object", objectId: row.id } },
          signal,
        });
        throwIfAborted(signal);
        entries.set(row.id, data
          ? { state: "ready", retentionUntil: data.retentionUntil ?? null }
          : { state: response.status === 404 ? "ready" : "unavailable", retentionUntil: null });
      } catch {
        throwIfAborted(signal);
        entries.set(row.id, { state: "unavailable", retentionUntil: null });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(RETENTION_READ_CONCURRENCY, rows.length) }, worker));
  throwIfAborted(signal);
  return entries;
}
