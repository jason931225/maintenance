import { useCallback, useEffect, useMemo, useState } from "react";

import type { MailThreadView } from "../../api/types";
import { useAuth } from "../../context/auth";

type MailSummaryState = "idle" | "loading" | "ready" | "error" | "unavailable";

// Compact inbox view for the comms rail's mail section. Reuses MailPage's exact
// thread call shape (`GET /api/v1/mail/threads`) so the two never drift, without
// dragging the 999-line MailPage into a refactor. Lazy: fetches only while
// `enabled` (the mail section is open and the feature is granted).
export function useMailSummary(enabled: boolean) {
  const { api } = useAuth();
  const [threads, setThreads] = useState<MailThreadView[]>([]);
  const [state, setState] = useState<MailSummaryState>("idle");

  const load = useCallback(async () => {
    if (!enabled) return;
    setState("loading");
    try {
      const res = await api.GET("/api/v1/mail/threads", {
        params: { query: { limit: 20 } },
      });
      if (res.response.status === 503) {
        setThreads([]);
        setState("unavailable");
        return;
      }
      if (!res.data) {
        setState("error");
        return;
      }
      setThreads(res.data);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [api, enabled]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const unread = useMemo(
    () => threads.reduce((sum, thread) => sum + Math.max(0, thread.unread_count), 0),
    [threads],
  );

  return { threads, unread, state, reload: load };
}
