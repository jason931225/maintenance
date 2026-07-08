import type { ConsoleApiClient } from "../api/client";
import { workOrderCode, type ObjectKind } from "./objectRegistry";
import { safeLabel } from "./utils";

export interface ObjectCandidate {
  kind: ObjectKind;
  /** Issued code for object-link/code-link kinds; the user id for `person`. */
  code: string;
  label: string;
}

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
export type CandidateProvider = (query: string) => Promise<ObjectCandidate[]>;

const CANDIDATE_LIMIT = 8;
const FETCH_PAGE_SIZE = 50;

function matches(needle: string, ...haystack: Array<string | null | undefined>): boolean {
  if (!needle) return true;
  return haystack.some((value) => value?.toLowerCase().includes(needle));
}

/** `@` mention candidates — real people, backed by the branch-scoped user list. */
export function createPersonCandidateProvider(api: ConsoleApiClient): CandidateProvider {
  return async (query) => {
    const response = await api.GET("/api/v1/users", {
      params: { query: { limit: FETCH_PAGE_SIZE } },
    });
    const needle = query.trim().toLowerCase();
    return (response.data?.items ?? [])
      .filter((user) => user.is_active && matches(needle, user.display_name, user.employee_name))
      .slice(0, CANDIDATE_LIMIT)
      .map((user) => ({
        kind: "person" as const,
        code: user.id,
        label: safeLabel(user.display_name, user.employee_name),
      }));
  };
}

/** `#`/`!` work-order candidates, backed by the branch-scoped work-order list. */
export function createWorkOrderCandidateProvider(api: ConsoleApiClient): CandidateProvider {
  return async (query) => {
    const response = await api.GET("/api/v1/work-orders", {
      params: { query: { limit: FETCH_PAGE_SIZE } },
    });
    const needle = query.trim().toLowerCase();
    return (response.data?.items ?? [])
      .filter((wo) =>
        matches(needle, wo.request_no, wo.customer.name, wo.site.name, wo.equipment.model),
      )
      .slice(0, CANDIDATE_LIMIT)
      .map((wo) => ({
        kind: "workOrder" as const,
        code: workOrderCode(wo.request_no),
        label: `${safeLabel(wo.customer.name)} · ${safeLabel(wo.equipment.model, wo.equipment.equipment_no)}`,
      }));
  };
}
