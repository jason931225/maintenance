import type {
  ConsoleMessengerMember,
  ConsoleMessengerMessage,
  ConsoleMessengerPresence,
  ConsoleMessengerThread,
  MessengerAckSummary,
  MessengerConsoleApi,
  MessengerThreadMuteSummary,
  TodoSummary,
} from "./types";

export function createMessengerConsoleApi(accessToken?: string): MessengerConsoleApi {
  return {
    listThreads: async () => (await requestJson<{ items: ConsoleMessengerThread[] }>("/api/messenger/threads?limit=50", { method: "GET" }, accessToken)).items,
    listChannels: async () => (await requestJson<{ items: ConsoleMessengerThread[] }>("/api/messenger/channels?limit=50", { method: "GET" }, accessToken)).items,
    joinChannel: async (threadId) => requestJson<ConsoleMessengerThread>(`/api/messenger/threads/${encodeURIComponent(threadId)}/join`, { method: "POST" }, accessToken),
    listMessages: async (threadId, beforeMessageId) => {
      const params = new URLSearchParams({ limit: "50" });
      if (beforeMessageId) params.set("before_message_id", beforeMessageId);
      return requestJson<{ items: ConsoleMessengerMessage[]; next_cursor: string | null }>(
        `/api/messenger/threads/${encodeURIComponent(threadId)}/messages?${params.toString()}`,
        { method: "GET" },
        accessToken,
      );
    },
    markRead: async (threadId, messageId) => {
      await requestJson<unknown>(
        `/api/messenger/threads/${encodeURIComponent(threadId)}/read-receipt`,
        { method: "PUT", body: JSON.stringify({ last_read_message_id: messageId }) },
        accessToken,
      );
    },
    listPresence: async (threadId) => (await requestJson<{ items: ConsoleMessengerPresence[] }>(`/api/messenger/threads/${encodeURIComponent(threadId)}/presence`, { method: "GET" }, accessToken)).items,
    listMembers: async (branchId) => {
      const params = new URLSearchParams({ limit: "100" });
      if (branchId) params.set("branch_id", branchId);
      return (await requestJson<{ items: ConsoleMessengerMember[] }>(`/api/messenger/members?${params.toString()}`, { method: "GET" }, accessToken)).items;
    },
    searchMessages: async (query) => (await requestJson<{ items: ConsoleMessengerMessage[] }>(`/api/messenger/search?${new URLSearchParams({ q: query, limit: "20" }).toString()}`, { method: "GET" }, accessToken)).items,
    sendMessage: async (threadId, body) => requestJson<ConsoleMessengerMessage>(
      `/api/messenger/threads/${encodeURIComponent(threadId)}/messages`,
      { method: "POST", body: JSON.stringify(body) },
      accessToken,
    ),
    toggleAck: async (messageId) => requestJson<MessengerAckSummary>(`/api/messenger/messages/${encodeURIComponent(messageId)}/ack`, { method: "POST" }, accessToken),
    setMute: async (threadId, muted) => requestJson<MessengerThreadMuteSummary>(
      `/api/messenger/threads/${encodeURIComponent(threadId)}/mute`,
      { method: "PUT", body: JSON.stringify({ muted }) },
      accessToken,
    ),
    createTodo: async (body) => requestJson<TodoSummary>(
      "/api/v1/me/todos",
      { method: "POST", body: JSON.stringify(body) },
      accessToken,
    ),
  };
}

async function requestJson<T>(path: string, init: RequestInit, accessToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    throw new Error(`messenger request failed ${String(response.status)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
