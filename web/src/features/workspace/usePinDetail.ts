import { useContext, useEffect, useState } from "react";

import { AuthContext } from "../../context/auth";
import { FETCHABLE_PIN_KINDS, fetchPinnedObject } from "./objectPin";
import type { PinnedObject } from "./types";

export type PinDetailStatus = "idle" | "loading" | "error";

export interface PinDetail {
  object: PinnedObject;
  status: PinDetailStatus;
}

interface LivePinDetail {
  object?: PinnedObject;
  status: PinDetailStatus;
  key: string;
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
  const [liveDetail, setLiveDetail] = useState<LivePinDetail>({
    key: "",
    status: "idle",
  });

  const api = auth?.api;
  const branchId = auth?.session?.branches?.[0];
  const { refId, kind, code } = snapshot;
  const detailKey = `${branchId ?? ""}:${kind}:${refId ?? ""}:${code}`;

  useEffect(() => {
    if (!api || !refId || !FETCHABLE_PIN_KINDS.has(kind)) return undefined;
    const guard = { live: true };
    void (async () => {
      setLiveDetail({ key: detailKey, status: "loading" });
      try {
        const fetched = await fetchPinnedObject(api, kind, { id: refId, code, branchId });
        if (!guard.live) return;
        if (!fetched) {
          setLiveDetail({ key: detailKey, status: "idle" });
          return;
        }
        setLiveDetail({ key: detailKey, object: { ...fetched, refId }, status: "idle" });
      } catch {
        if (!guard.live) return;
        setLiveDetail({ key: detailKey, status: "error" });
      }
    })();
    return () => {
      guard.live = false;
    };
  }, [api, branchId, refId, kind, code, detailKey]);

  const currentLiveDetail = liveDetail.key === detailKey ? liveDetail : undefined;
  return {
    object: currentLiveDetail?.object ?? snapshot,
    status: currentLiveDetail?.status ?? "idle",
  };
}
