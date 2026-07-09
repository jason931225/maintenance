import type { ConsoleApiClient } from "../api/client";
import { apCode } from "../features/eApprovals/approvals-data";
import { workOrderCode, type ObjectKind } from "./objectRegistry";
import { safeLabel } from "./utils";

export interface ObjectCandidate {
  kind: ObjectKind;
  /** Issued code for object-link/code-link kinds; the user id for `person`. */
  code: string;
  label: string;
  /** Backend row id (a UUID) for coded kinds, used to route/pin the real
   * object — the display `code` (e.g. "WO-20260612-001") is not the detail
   * route key. Absent for `person`, whose `code` already IS the id. */
  id?: string;
  /** Lowercased haystack the caller re-filters locally as the query narrows.
   * A provider fetches one page; `filterCandidates` matches against this, so a
   * burst of keystrokes never refetches. */
  search: string;
}

/** Distinguishes "loaded, zero matches" from "the fetch failed" — a provider
 * must never collapse a 403/network error into an empty dropdown, which a
 * caller would otherwise render as "no results" instead of an error state. */
export type CandidateResult =
  | { status: "ok"; candidates: ObjectCandidate[] }
  | { status: "error" };

/**
 * Kind-scoped candidate lookup for the token-grammar dropdown: fetch one
 * permission-scoped page for exactly one object kind and return every visible
 * row as a candidate. The caller re-filters the page locally (`filterCandidates`)
 * as the query narrows, so typing never refetches.
 *
 * PBAC contract: a provider must return ONLY objects the signed-in principal
 * is permitted to see (deny-by-omission, DESIGN.md §4.5). This module never
 * adds its own authorization layer — every provider here is backed directly
 * by a branch/RLS-scoped read endpoint, so permission scoping is inherited
 * from the server, not re-implemented client-side. A `!CODE` that doesn't
 * resolve through a provider must be left as plain text by the caller
 * (`TokenText`'s `resolveObject`), never rendered as a link.
 */
export type CandidateProvider = () => Promise<CandidateResult>;

const CANDIDATE_LIMIT = 8;
// Same constraint as work orders below: /api/messenger/members has no
// text-search query param, so this fetches one page and filters client-side —
// matches beyond this page size are invisible to the dropdown.
const MEMBER_FETCH_PAGE_SIZE = 100;

/** Narrow a fetched page to the visible dropdown slice by matching `query`
 * against each candidate's `search` haystack — the per-keystroke step, no
 * network. Empty query shows the head of the page. */
export function filterCandidates(candidates: ObjectCandidate[], query: string): ObjectCandidate[] {
  const needle = query.trim().toLowerCase();
  const matched = needle ? candidates.filter((c) => c.search.includes(needle)) : candidates;
  return matched.slice(0, CANDIDATE_LIMIT);
}

/**
 * `@` mention candidates — real people.
 *
 * Deliberately NOT `/api/v1/users`: that endpoint requires `Feature::UserManage`
 * (admin/super-admin only — see `identity/rest/src/lib.rs`'s `list_users`, and
 * `DispatchPage.tsx`'s own `loadMechanics` which gates the same endpoint behind
 * `isManager`), so a regular employee mentioning a coworker would always get a
 * 403 and a permanently-empty dropdown. `/api/messenger/members` is the
 * existing branch-scoped, non-admin endpoint built for exactly this ("discover
 * active coworkers... without requiring the admin-only user-management
 * endpoint") — reused here instead of adding a new one.
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

// ponytail: /api/v1/work-orders has no text-search query param, so this fetches
// one page and filters client-side — matches past FETCH_PAGE_SIZE are invisible
// to the dropdown. 100 is the endpoint's own server-side max (openapi.yaml),
// so this is the largest single page obtainable; add real search if that ceiling
// ever bites in practice.
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
      // contain a newline) — equivalent to the old per-field OR match.
      search: [wo.request_no, wo.customer.name, wo.site.name, wo.equipment.model, wo.equipment.equipment_no]
        .map((value) => value?.toLowerCase() ?? "")
        .join("\n"),
    }));
    return { status: "ok", candidates };
  };
}

/**
 * `!`/`#` AP- (전자결재) candidates, backed by the caller's own submission box
 * (`/api/v1/workflow-runs/mine`) — the PBAC-scoped, all-employee run list. Runs
 * the caller cannot see are absent (deny-by-omission, server-scoped).
 */
export function createApprovalCandidateProvider(api: ConsoleApiClient): CandidateProvider {
  return async () => {
    let response;
    try {
      response = await api.GET("/api/v1/workflow-runs/mine", {});
    } catch {
      return { status: "error" };
    }
    if (response.error || !response.response.ok) return { status: "error" };

    const candidates = response.data.items.map((run) => {
      const code = apCode(run.run_id);
      return {
        kind: "approval" as const,
        code,
        id: run.run_id,
        label: run.object_type ? safeLabel(run.object_type) : code,
        search: [code, run.object_type, run.status]
          .map((value) => value?.toLowerCase() ?? "")
          .join("\n"),
      };
    });
    return { status: "ok", candidates };
  };
}
