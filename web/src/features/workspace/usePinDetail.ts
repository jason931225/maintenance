import { useContext, useEffect, useState } from "react";

import { AuthContext } from "../../context/auth";
import { fetchPinnedObject } from "./objectPin";
import type { PinKind, PinnedObject } from "./types";

const FETCHABLE: ReadonlySet<PinKind> = new Set<PinKind>([
  "person",
  "workOrder",
  "support",
  "org",
]);

export type PinDetailStatus = "idle" | "loading" | "error";

export interface PinDetail {
  object: PinnedObject;
  status: PinDetailStatus;
}

/**
 * Enrich a pinned panel with live detail on mount (UI-M2a): the pinned snapshot
 * renders instantly, then `fetchPinnedObject` replaces it with the real body
 * (which, for a person, is what records the server-side view-audit). Reads the
 * nullable `AuthContext` directly — not `useAuth`, which throws — so a
 * standalone PinPanel render with no provider simply skips the fetch and keeps
 * the snapshot. Kinds with no detail endpoint (approval/dailyPlan/…) or a pin
 * created without an id never fetch.
 */
export function usePinDetail(snapshot: PinnedObject): PinDetail {
  const auth = useContext(AuthContext);
  const [detail, setDetail] = useState<PinDetail>({ object: snapshot, status: "idle" });

  const api = auth?.api;
  const branchId = auth?.session?.branches?.[0];
  const { refId, kind, code } = snapshot;

  useEffect(() => {
    if (!api || !refId || !FETCHABLE.has(kind)) return undefined;
    const guard = { live: true };
    void (async () => {
      setDetail((d) => ({ object: d.object, status: "loading" }));
      const fetched = await fetchPinnedObject(api, kind, { id: refId, code, branchId });
      if (!guard.live) return;
      if (!fetched) {
        setDetail((d) => ({ object: d.object, status: "error" }));
        return;
      }
      setDetail({ object: { ...fetched, refId }, status: "idle" });
    })();
    return () => {
      guard.live = false;
    };
  }, [api, branchId, refId, kind, code]);

  return detail;
}
