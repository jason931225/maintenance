// Live binding for LifecycleCard — the REAL BE-LC REST surface (#211) via the
// shared typed OpenAPI client. No fabricated data: the state, history, hold and
// every transition come from / go to the server, which audits each mutation and
// appends the transition log.

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "../../context/auth";
import type { Lifecycle } from "./types";

export type LifecycleStatus = "loading" | "ready" | "absent" | "error";

export interface UseLifecycle {
  record?: Lifecycle;
  status: LifecycleStatus;
  reload: () => Promise<void>;
  transition: (toState: string, reason: string) => Promise<Lifecycle | undefined>;
  setHold: (legalHold: boolean, retentionUntil?: string) => Promise<Lifecycle | undefined>;
}

const PATH = "/api/v1/lifecycles/{objectType}/{objectId}" as const;

export function useLifecycle(objectType: string, objectId: string): UseLifecycle {
  const { api } = useAuth();
  const [record, setRecord] = useState<Lifecycle | undefined>();
  const [status, setStatus] = useState<LifecycleStatus>("loading");

  const reload = useCallback(async () => {
    setStatus("loading");
    try {
      const { data, response } = await api.GET(PATH, {
        params: { path: { objectType, objectId } },
      });
      if (data) {
        setRecord(data);
        setStatus("ready");
      } else if (response.status === 404) {
        // No lifecycle row yet — the object exists but has never transitioned.
        setStatus("absent");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }, [api, objectType, objectId]);

  useEffect(() => {
    // Defer to a microtask so the load's setState is not called synchronously
    // in the effect body (react-hooks/set-state-in-effect); mirrors the
    // InspectionPage initial-fetch pattern.
    void Promise.resolve().then(() => reload());
  }, [reload]);

  const transition = useCallback(
    async (toState: string, reason: string) => {
      const { data } = await api.POST(`${PATH}/transition`, {
        params: { path: { objectType, objectId } },
        body: { toState, reason },
      });
      if (data) {
        setRecord(data);
        setStatus("ready");
      }
      return data;
    },
    [api, objectType, objectId],
  );

  const setHold = useCallback(
    async (legalHold: boolean, retentionUntil?: string) => {
      const { data } = await api.POST(`${PATH}/hold`, {
        params: { path: { objectType, objectId } },
        body: { legalHold, retentionUntil },
      });
      if (data) {
        setRecord(data);
        setStatus("ready");
      }
      return data;
    },
    [api, objectType, objectId],
  );

  return { record, status, reload, transition, setHold };
}
