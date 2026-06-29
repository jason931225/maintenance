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
  | { type: "threadCreated"; thread: MessengerThreadSummary }
  | { type: "threadSelected"; threadId: string }
  | {
      type: "messagesPageLoaded";
      threadId: string;
      page: MessengerMessagePage;
    }
  | { type: "messageSent"; message: MessengerMessageSummary }
  | { type: "threadRead"; threadId: string }
  | { type: "searchResultsLoaded"; results: MessengerMessageSummary[] }
  | {
      type: "realtimeEventReceived";
      event: MessengerRealtimeEvent;
      selectedThreadId?: string;
      currentUserId?: string;
    };

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
    case "threadCreated":
      return {
        ...state,
        threads: sortThreads([
          action.thread,
          ...state.threads.filter((thread) => thread.id !== action.thread.id),
        ]),
        selectedThreadId: action.thread.id,
      };
    case "threadSelected":
      return {
        ...state,
        selectedThreadId: action.threadId,
      };
    case "messagesPageLoaded":
      return mergeThreadMessages(state, action.threadId, action.page);
    case "messageSent":
      return upsertMessage(state, action.message, { markRead: true });
    case "threadRead":
      return markThreadRead(state, action.threadId);
    case "searchResultsLoaded":
      return {
        ...state,
        searchResults: sortMessages(action.results),
      };
    case "realtimeEventReceived":
      return upsertMessage(state, action.event.message, {
        markRead: action.event.message.thread_id === action.selectedThreadId,
        incrementUnread:
          action.event.message.thread_id !== action.selectedThreadId &&
          action.event.message.sender_id !== action.currentUserId,
      });
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
  options: { markRead?: boolean; incrementUnread?: boolean } = {},
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
              unread_count: nextUnreadCount(thread, options),
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

function markThreadRead(state: MessengerState, threadId: string): MessengerState {
  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id === threadId ? { ...thread, unread_count: 0 } : thread,
    ),
  };
}

function nextUnreadCount(
  thread: MessengerThreadSummary,
  options: { markRead?: boolean; incrementUnread?: boolean },
): number {
  if (options.markRead) {
    return 0;
  }
  if (options.incrementUnread) {
    return Math.max(0, thread.unread_count) + 1;
  }
  return Math.max(0, thread.unread_count);
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
