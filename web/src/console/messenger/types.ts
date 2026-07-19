import type {
  MessengerMemberSummary,
  MessengerMessageSummary,
  MessengerThreadSummary,
} from "../../api/types";

export type MessengerThreadVisibility = "channel" | "direct";
export type MessengerPresenceStatus = "online" | "away" | "offline";

export type ConsoleMessengerThread = MessengerThreadSummary & {
  visibility?: MessengerThreadVisibility;
  muted?: boolean;
  joined?: boolean;
};

export type ConsoleMessengerMessage = MessengerMessageSummary & {
  ack_count?: number;
  acked_by_me?: boolean;
  quoted_message_id?: string | null;
  quoted_body?: string | null;
  quoted_sender_name?: string | null;
};

export type ConsoleMessengerMember = MessengerMemberSummary;

export interface ConsoleMessengerPresence {
  user_id: string;
  display_name: string | null;
  last_activity_at: string | null;
  status: MessengerPresenceStatus;
}

export interface MessengerAckSummary {
  message_id: string;
  thread_id: string;
  acked: boolean;
  ack_count: number;
}

export interface MessengerThreadMuteSummary {
  thread_id: string;
  muted: boolean;
}

export interface TodoRef {
  kind: string;
  id: string;
  label?: string;
}

export interface TodoSummary {
  id: string;
  owner_user_id: string;
  text: string;
  scopes: TodoRef[];
  links: TodoRef[];
  done: boolean;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

export interface MessengerConsoleApi {
  listThreads: () => Promise<ConsoleMessengerThread[]>;
  listChannels: () => Promise<ConsoleMessengerThread[]>;
  joinChannel: (threadId: string) => Promise<ConsoleMessengerThread>;
  listMessages: (
    threadId: string,
    beforeMessageId?: string | null,
  ) => Promise<{ items: ConsoleMessengerMessage[]; next_cursor: string | null }>;
  markRead: (threadId: string, messageId: string) => Promise<void>;
  listPresence: (threadId: string) => Promise<ConsoleMessengerPresence[]>;
  listMembers: (branchId: string) => Promise<ConsoleMessengerMember[]>;
  searchMessages: (query: string) => Promise<ConsoleMessengerMessage[]>;
  sendMessage: (
    threadId: string,
    body: { body: string; attachment_evidence_ids?: string[]; quoted_message_id?: string | null },
  ) => Promise<ConsoleMessengerMessage>;
  toggleAck: (messageId: string) => Promise<MessengerAckSummary>;
  setMute: (threadId: string, muted: boolean) => Promise<MessengerThreadMuteSummary>;
  createTodo: (body: { text: string; scopes?: TodoRef[]; links?: TodoRef[] }) => Promise<TodoSummary>;
}
