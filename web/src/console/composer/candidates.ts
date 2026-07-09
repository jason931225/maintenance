import type { ConsoleApiClient } from "../../api/client";
import { safeLabel } from "../../lib/utils";
import type { ObjectCandidate } from "./objectKinds";

/**
 * PBAC-gated candidate lookup for the composer dropdown — TRANSFERRED from
 * `web/src/lib/objectCandidates.ts` (charter D4: transfer the data flow, rebuild
 * the rendering). Fetch-once-per-trigger-session semantics from the merged
 * simplify pass are PRESERVED: a provider fetches ONE permission-scoped page,
 * the composer re-filters it locally (`filterCandidates`) per keystroke, so a
 * burst of typing never refetches.
 *
 * PBAC contract (DESIGN §4.5, deny-by-omission): every provider is backed
 * directly by a branch/RLS-scoped read endpoint, so a candidate the principal
 * can't see never appears — no client-side authorization layer. A `!CODE` that
 * resolves through no provider is left as inert plain text by the renderer,
 * never a link.
 */

/** Distinguishes "loaded, zero matches" from "the fetch failed" — a provider
 * must never collapse a 403/network error into an empty dropdown, which the
 * composer would otherwise render as "no results" instead of an error state. */
export type CandidateResult =
  | { status: "ok"; candidates: ObjectCandidate[] }
  | { status: "error" };

export type CandidateProvider = () => Promise<CandidateResult>;

const CANDIDATE_LIMIT = 8;
// /api/messenger/members has no text-search query param, so this fetches one
// page and filters client-side — matches beyond this page size are invisible.
const MEMBER_FETCH_PAGE_SIZE = 100;

/** Narrow a fetched page to the visible dropdown slice by matching `query`
 * against each candidate's `search` haystack — the per-keystroke step, no
 * network. Empty query shows the head of the page. */
export function filterCandidates(candidates: ObjectCandidate[], query: string): ObjectCandidate[] {
  const needle = query.trim().toLowerCase();
  const matched = needle ? candidates.filter((c) => c.search.includes(needle)) : candidates;
  return matched.slice(0, CANDIDATE_LIMIT);
}

/** Work-order display code: the backend `request_no` has no "WO-" prefix
 * (`^[0-9]{8}-[0-9]{3}$`); this applies the design-grammar prefix. */
export function workOrderCode(requestNo: string): string {
  return `WO-${requestNo}`;
}

/**
 * `@` mention candidates — real people. Deliberately NOT `/api/v1/users`
 * (admin-only `Feature::UserManage`, a 403 for regular employees). The
 * branch-scoped, non-admin `/api/messenger/members` is the endpoint built for
 * exactly "discover active coworkers" — reused, not re-added.
 */
export function createPersonCandidateProvider(
  api: ConsoleApiClient,
  branchId: string,
): CandidateProvider {
  return async () => {
    let response;
    try {
      response = await api.GET("/api/messenger/members", {
        params: { query: { branch_id: branchId, limit: MEMBER_FETCH_PAGE_SIZE } },
      });
    } catch {
      return { status: "error" };
    }
    if (response.error || !response.response.ok) return { status: "error" };

    const candidates = response.data.items.map((member) => ({
      kind: "person" as const,
      code: member.id,
      label: safeLabel(member.display_name),
      search: member.display_name.toLowerCase(),
    }));
    return { status: "ok", candidates };
  };
}

// /api/v1/work-orders has no text-search query param either; 100 is the
// endpoint's server-side max, so this is the largest single page obtainable.
const FETCH_PAGE_SIZE = 100;

/** `#`/`!` work-order candidates, backed by the branch-scoped work-order list. */
export function createWorkOrderCandidateProvider(api: ConsoleApiClient): CandidateProvider {
  return async () => {
    let response;
    try {
      response = await api.GET("/api/v1/work-orders", {
        params: { query: { limit: FETCH_PAGE_SIZE } },
      });
    } catch {
      return { status: "error" };
    }
    if (response.error || !response.response.ok) return { status: "error" };

    const candidates = response.data.items.map((wo) => ({
      kind: "workOrder" as const,
      code: workOrderCode(wo.request_no),
      id: wo.id,
      label: `${safeLabel(wo.customer.name)} · ${safeLabel(wo.equipment.model, wo.equipment.equipment_no)}`,
      // "\n"-joined so a needle can't match across two fields (queries never
      // contain a newline).
      search: [wo.request_no, wo.customer.name, wo.site.name, wo.equipment.model, wo.equipment.equipment_no]
        .map((value) => value?.toLowerCase() ?? "")
        .join("\n"),
    }));
    return { status: "ok", candidates };
  };
}
