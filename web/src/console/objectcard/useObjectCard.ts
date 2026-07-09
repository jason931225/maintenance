import { useCallback, useEffect, useState } from "react";

import type { components } from "@maintenance/api-client-ts";
import type { ConsoleApiClient } from "../../api/client";
import { linkTargetFromCode } from "./kinds";

export type ObjectHead = components["schemas"]["ObjectHead"];
export type ObjectLifecycle = components["schemas"]["ObjectLifecycle"];
export type ObjectLinkResponse = components["schemas"]["ObjectLinkResponse"];

/**
 * One audit-timeline row. The general audit query (`GET /api/audit`, added by
 * BE-OBJ #206 with the `target_id` filter) is an APP-LEVEL route that is NOT in
 * the served OpenAPI, so it is absent from the generated typed client — this
 * shape mirrors the backend `AuditRecord` we consume.
 *
 * ponytail: openapi backfill gap — `GET /api/audit` should be added to
 * `backend/openapi/openapi.yaml` so this becomes a typed client call and this
 * hand-shape + raw fetch below both disappear. Named per the charter P0.6 note.
 */
export interface AuditEntry {
  id: string;
  action: string;
  actor: string | null;
  target_type: string;
  occurred_at: string;
}

interface AuditPage {
  items: AuditEntry[];
}

const AUDIT_LIMIT = 20;
const RELATES_TO = "relates_to";

/** Policy actions every object-card affordance routes through the gate with. */
export const OBJECT_CARD_ACTIONS = {
  linkCreate: "object.link.create",
  linkDelete: "object.link.delete",
  view: "object.view",
} as const;

/** Distinct load outcomes so the card can tell "denied/absent" (render nothing)
 * from "loaded, empty" (render an empty layer) from "still loading". */
export interface ObjectCardState {
  status: "loading" | "resolved" | "absent" | "error";
  head?: ObjectHead;
  /** null = lifecycle not visible/registered (deny-by-omission) — no chip. */
  lifecycle: ObjectLifecycle | null;
  /** null = audit read denied — no timeline. */
  audit: AuditEntry[] | null;
  links: { outgoing: ObjectLinkResponse[]; incoming: ObjectLinkResponse[] };
}

function auditBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

/**
 * Fetch one object's audit timeline via the app-level `GET /api/audit`
 * (`target_id` filter). Mirrors the typed client's transport (bearer header,
 * cookie transport opt-in, credentials) minimally. Returns `null` on any
 * non-2xx (403 = not an auditor → deny-by-omission; the layer renders nothing).
 *
 * ponytail: no 401-refresh-retry here (the three typed calls already refresh);
 * a raw-fetch 401 degrades the timeline to empty, acceptable for a read layer.
 * Add the retry if this ever gates a mutation — it does not.
 */
async function fetchObjectAudit(
  bearerToken: string | undefined,
  target: { kind: string; id: string },
): Promise<AuditEntry[] | null> {
  const params = new URLSearchParams({ target_id: target.id, limit: String(AUDIT_LIMIT) });
  const headers: Record<string, string> = { Accept: "application/json", "X-Auth-Transport": "cookie" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  let response: Response;
  try {
    response = await fetch(`${auditBaseUrl()}/api/audit?${params.toString()}`, {
      headers,
      credentials: "include",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const page = (await response.json()) as AuditPage;
  return Array.isArray(page.items) ? page.items : [];
}

const EMPTY_LINKS: { outgoing: ObjectLinkResponse[]; incoming: ObjectLinkResponse[] } = {
  outgoing: [],
  incoming: [],
};

/**
 * Loads and mutates the three object-card layers for one (kind, id) off the
 * shared object substrate. Deny-by-omission is the top guard: an object that
 * does not resolve (`exists=false`) yields `status: "absent"` and the card
 * renders nothing. Each sub-layer independently degrades to null/empty when its
 * own read is denied.
 */
export function useObjectCard(
  api: ConsoleApiClient,
  bearerToken: string | undefined,
  target: { kind: string; id: string },
) {
  const [state, setState] = useState<ObjectCardState>({
    status: "loading",
    lifecycle: null,
    audit: null,
    links: { outgoing: [], incoming: [] },
  });

  const loadLinks = useCallback(async () => {
    const response = await api.GET("/api/v1/object-links", {
      params: { query: { kind: target.kind, id: target.id } },
    });
    if (response.error) return EMPTY_LINKS;
    return { outgoing: response.data.outgoing, incoming: response.data.incoming };
  }, [api, target.kind, target.id]);

  const { kind, id } = target;

  // Load the three layers on mount / target change. The async worker lives
  // INSIDE the effect with an `ignore` guard (the codebase's proven load
  // pattern) so a superseded load never writes stale state, and state is set
  // only after an await — never synchronously in the effect body.
  useEffect(() => {
    // Cancellation flag read through a function so a superseded load's guard
    // sees the live value (a bare boolean gets control-flow-narrowed to its
    // initializer, tripping no-unnecessary-condition).
    const run = { cancelled: false };
    const cancelled = () => run.cancelled;
    async function load() {
      const resolved = await api.GET("/api/objects/{kind}/{id}", {
        params: { path: { kind, id } },
      });
      if (cancelled()) return;
      if (resolved.error) {
        setState({ status: "error", lifecycle: null, audit: null, links: EMPTY_LINKS });
        return;
      }
      const head = resolved.data;
      if (!head.exists) {
        // Deny-by-omission: absent OR outside scope, indistinguishably — no card.
        setState({ status: "absent", head, lifecycle: null, audit: null, links: EMPTY_LINKS });
        return;
      }
      const [lifecycle, audit, links] = await Promise.all([
        api
          .GET("/api/v1/lifecycles/{objectType}/{objectId}", {
            params: { path: { objectType: kind, objectId: id } },
          })
          .then((r) => (r.error ? null : (r.data ?? null)))
          .catch(() => null),
        fetchObjectAudit(bearerToken, { kind, id }),
        loadLinks(),
      ]);
      if (cancelled()) return;
      setState({ status: "resolved", head, lifecycle, audit, links });
    }
    void load();
    return () => {
      run.cancelled = true;
    };
  }, [api, bearerToken, kind, id, loadLinks]);

  /**
   * Draw a relation from this object to a bare-code target. Returns false
   * without a mutation when the code isn't a linkable object (deny-by-omission),
   * so the caller can leave the input untouched rather than fake a link.
   */
  const addRelation = useCallback(
    async (code: string): Promise<boolean> => {
      const dst = linkTargetFromCode(code);
      if (!dst) return false;
      const response = await api.POST("/api/v1/object-links", {
        body: {
          src_kind: target.kind,
          src_id: target.id,
          dst_kind: dst.kind,
          dst_id: dst.id,
          link_type: RELATES_TO,
        },
      });
      if (response.error) return false;
      const links = await loadLinks();
      setState((prev) => ({ ...prev, links }));
      return true;
    },
    [api, target.kind, target.id, loadLinks],
  );

  const removeRelation = useCallback(
    async (linkId: string): Promise<boolean> => {
      const response = await api.DELETE("/api/v1/object-links/{id}", {
        params: { path: { id: linkId } },
      });
      if (response.error) return false;
      const links = await loadLinks();
      setState((prev) => ({ ...prev, links }));
      return true;
    },
    [api, loadLinks],
  );

  return { state, addRelation, removeRelation };
}
