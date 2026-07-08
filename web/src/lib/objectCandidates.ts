import type { ConsoleApiClient } from "../api/client";
import { workOrderCode, type ObjectKind } from "./objectRegistry";
import { safeLabel } from "./utils";

export interface ObjectCandidate {
  kind: ObjectKind;
  /** Issued code for object-link/code-link kinds; the user id for `person`. */
  code: string;
  label: string;
}

/** Distinguishes "loaded, zero matches" from "the fetch failed" — a provider
 * must never collapse a 403/network error into an empty dropdown, which a
 * caller would otherwise render as "no results" instead of an error state. */
export type CandidateResult =
  | { status: "ok"; candidates: ObjectCandidate[] }
  | { status: "error" };

/**
 * Kind-scoped candidate lookup for the token-grammar dropdown: given the
 * in-progress query text (may be empty — "show everything"), resolve
 * candidates for exactly one object kind.
 *
 * PBAC contract: a provider must return ONLY objects the signed-in principal
 * is permitted to see (deny-by-omission, DESIGN.md §4.5). This module never
 * adds its own authorization layer — every provider here is backed directly
 * by a branch/RLS-scoped read endpoint, so permission scoping is inherited
 * from the server, not re-implemented client-side. A `!CODE` that doesn't
 * resolve through a provider must be left as plain text by the caller
 * (`TokenText`'s `resolveObject`), never rendered as a link.
 */
export type CandidateProvider = (query: string) => Promise<CandidateResult>;

const CANDIDATE_LIMIT = 8;

function matches(needle: string, ...haystack: Array<string | null | undefined>): boolean {
  if (!needle) return true;
  return haystack.some((value) => value?.toLowerCase().includes(needle));
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
  return async (query) => {
    let response;
    try {
      response = await api.GET("/api/messenger/members", {
        params: { query: { branch_id: branchId, limit: 100 } },
      });
    } catch {
      return { status: "error" };
    }
    if (response.error || !response.response.ok) return { status: "error" };

    const needle = query.trim().toLowerCase();
    const candidates = response.data.items
      .filter((member) => matches(needle, member.display_name))
      .slice(0, CANDIDATE_LIMIT)
      .map((member) => ({
        kind: "person" as const,
        code: member.id,
        label: safeLabel(member.display_name),
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
  return async (query) => {
    let response;
    try {
      response = await api.GET("/api/v1/work-orders", {
        params: { query: { limit: FETCH_PAGE_SIZE } },
      });
    } catch {
      return { status: "error" };
    }
    if (response.error || !response.response.ok) return { status: "error" };

    const needle = query.trim().toLowerCase();
    const candidates = response.data.items
      .filter((wo) =>
        matches(needle, wo.request_no, wo.customer.name, wo.site.name, wo.equipment.model),
      )
      .slice(0, CANDIDATE_LIMIT)
      .map((wo) => ({
        kind: "workOrder" as const,
        code: workOrderCode(wo.request_no),
        label: `${safeLabel(wo.customer.name)} · ${safeLabel(wo.equipment.model, wo.equipment.equipment_no)}`,
      }));
    return { status: "ok", candidates };
  };
}
