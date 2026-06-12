import type {
  MessengerMessagePage,
  MessengerMessageSummary,
  MessengerThreadSummary,
} from "../../api/types";

export interface MessengerRealtimeEvent {
  type: "message_posted";
  message: MessengerMessageSummary;
}

export interface MessengerState {
  threads: MessengerThreadSummary[];
  selectedThreadId?: string;
  messagesByThread: Record<string, MessengerMessageSummary[]>;
  nextCursorByThread: Record<string, string | null>;
  lastMessageIdByThread: Record<string, string>;
  searchResults: MessengerMessageSummary[];
}

export type MessengerAction =
  | { type: "threadsLoaded"; threads: MessengerThreadSummary[] }
  | { type: "threadSelected"; threadId: string }
  | {
      type: "messagesPageLoaded";
      threadId: string;
      page: MessengerMessagePage;
    }
  | { type: "messageSent"; message: MessengerMessageSummary }
  | { type: "searchResultsLoaded"; results: MessengerMessageSummary[] }
  | { type: "realtimeEventReceived"; event: MessengerRealtimeEvent };

export function createMessengerState(): MessengerState {
  return {
    threads: [],
    messagesByThread: {},
    nextCursorByThread: {},
    lastMessageIdByThread: {},
    searchResults: [],
  };
}

export function messengerReducer(
  state: MessengerState,
  action: MessengerAction,
): MessengerState {
  switch (action.type) {
    case "threadsLoaded":
      return {
        ...state,
        threads: sortThreads(action.threads),
        selectedThreadId: state.selectedThreadId ?? action.threads[0]?.id,
      };
    case "threadSelected":
      return {
        ...state,
        selectedThreadId: action.threadId,
      };
    case "messagesPageLoaded":
      return mergeThreadMessages(state, action.threadId, action.page);
    case "messageSent":
      return upsertMessage(state, action.message);
    case "searchResultsLoaded":
      return {
        ...state,
        searchResults: sortMessages(action.results),
      };
    case "realtimeEventReceived":
      return upsertMessage(state, action.event.message);
  }
}

export function resumeCursor(state: MessengerState): string | undefined {
  const latest = Object.values(state.messagesByThread)
    .flat()
    .sort(compareMessages)
    .at(-1);
  return latest?.id;
}

function mergeThreadMessages(
  state: MessengerState,
  threadId: string,
  page: MessengerMessagePage,
): MessengerState {
  const messages = mergeMessages(state.messagesByThread[threadId] ?? [], page.items);
  return {
    ...state,
    messagesByThread: {
      ...state.messagesByThread,
      [threadId]: messages,
    },
    nextCursorByThread: {
      ...state.nextCursorByThread,
      [threadId]: page.next_cursor,
    },
    lastMessageIdByThread: {
      ...state.lastMessageIdByThread,
      ...(messages.at(-1) ? { [threadId]: messages.at(-1)?.id ?? "" } : {}),
    },
  };
}

function upsertMessage(
  state: MessengerState,
  message: MessengerMessageSummary,
): MessengerState {
  const messages = mergeMessages(
    state.messagesByThread[message.thread_id] ?? [],
    [message],
  );
  return {
    ...state,
    threads: sortThreads(
      state.threads.map((thread) =>
        thread.id === message.thread_id
          ? {
              ...thread,
              last_message_id: message.id,
              last_message_at: message.sent_at,
              updated_at: message.created_at,
            }
          : thread,
      ),
    ),
    messagesByThread: {
      ...state.messagesByThread,
      [message.thread_id]: messages,
    },
    lastMessageIdByThread: {
      ...state.lastMessageIdByThread,
      [message.thread_id]: message.id,
    },
  };
}

function mergeMessages(
  existing: MessengerMessageSummary[],
  incoming: MessengerMessageSummary[],
) {
  const byId = new Map<string, MessengerMessageSummary>();
  for (const message of existing) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return sortMessages([...byId.values()]);
}

function sortMessages(messages: MessengerMessageSummary[]) {
  return [...messages].sort(compareMessages);
}

function compareMessages(
  left: MessengerMessageSummary,
  right: MessengerMessageSummary,
) {
  const sentAt = left.sent_at.localeCompare(right.sent_at);
  if (sentAt !== 0) {
    return sentAt;
  }
  return left.id.localeCompare(right.id);
}

function sortThreads(threads: MessengerThreadSummary[]) {
  return [...threads].sort((left, right) => {
    const leftAt = left.last_message_at ?? left.updated_at;
    const rightAt = right.last_message_at ?? right.updated_at;
    const byTime = rightAt.localeCompare(leftAt);
    if (byTime !== 0) {
      return byTime;
    }
    return left.id.localeCompare(right.id);
  });
}
