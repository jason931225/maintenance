import {
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  EvidencePresignResponse,
  MessengerMessageSummary,
  MessengerThreadSummary,
  UserSummary,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { SkeletonCards } from "../../components/states/Skeleton";
import { cn } from "../../lib/utils";
import { ko } from "../../i18n/ko";
import {
  createMessengerState,
  messengerReducer,
  resumeCursor,
} from "./messenger-state";
import { connectMessengerRealtime } from "./realtime";

interface MessengerPanelProps {
  api: ConsoleApiClient;
  accessToken?: string;
  apiBaseUrl: string;
  /** Branch the new thread is scoped to (first JWT branch claim). */
  branchId?: string;
  /** Signed-in member id, excluded from the participant picker. */
  currentUserId?: string;
}

/**
 * The human label for a thread: its title when set, otherwise a generic
 * kind-based label. NEVER the raw thread/work-order UUID. (A real work-order
 * NUMBER would require a backend schema addition — `work_order_id` is a UUID.)
 */
function threadTitle(thread: MessengerThreadSummary): string {
  const title = thread.title?.trim();
  if (title) return title;
  return ko.messenger.untitled[thread.kind];
}

type LoadState = "idle" | "loading" | "error";

export function MessengerPanel({
  api,
  accessToken,
  apiBaseUrl,
  branchId,
  currentUserId,
}: MessengerPanelProps) {
  const [state, dispatch] = useReducer(
    messengerReducer,
    undefined,
    createMessengerState,
  );
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [composer, setComposer] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [attachment, setAttachment] = useState<File>();
  const [sendError, setSendError] = useState<string>();
  const [isSending, setIsSending] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isComposingThread, setIsComposingThread] = useState(false);
  const [members, setMembers] = useState<UserSummary[]>([]);
  const [newSubject, setNewSubject] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const cursorRef = useRef<string | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedThread = state.threads.find(
    (thread) => thread.id === state.selectedThreadId,
  );
  const selectedMessages = state.selectedThreadId
    ? state.messagesByThread[state.selectedThreadId] ?? []
    : [];

  useEffect(() => {
    cursorRef.current = resumeCursor(state);
  }, [state]);

  // Auto-grow the chat composer from one line up to its CSS max-height, so a
  // short message stays compact but a longer draft expands instead of forcing
  // an inner scrollbar from the first character.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [composer]);

  const markRead = useCallback(
    async (threadId: string, messageId: string) => {
      await api.PUT("/api/messenger/threads/{threadId}/read-receipt", {
        params: { path: { threadId } },
        body: { last_read_message_id: messageId },
      });
    },
    [api],
  );

  const loadMessages = useCallback(
    async (threadId: string, beforeMessageId?: string | null) => {
      const response = await api.GET(
        "/api/messenger/threads/{threadId}/messages",
        {
          params: {
            path: { threadId },
            query: { before_message_id: beforeMessageId ?? undefined, limit: 50 },
          },
        },
      );
      if (!response.data) {
        throw new Error("messenger messages response missing data");
      }
      dispatch({
        type: "messagesPageLoaded",
        threadId,
        page: response.data,
      });
      const lastMessage = response.data.items.at(-1);
      if (lastMessage) {
        await markRead(threadId, lastMessage.id);
      }
    },
    [api, markRead],
  );

  const loadThreads = useCallback(async () => {
    if (!accessToken) {
      return;
    }
    setLoadState("loading");
    try {
      const response = await api.GET("/api/messenger/threads", {
        params: { query: { limit: 50 } },
      });
      if (!response.data) {
        throw new Error("messenger threads response missing data");
      }
      dispatch({ type: "threadsLoaded", threads: response.data.items });
      const selectedId = response.data.items.at(0)?.id;
      if (selectedId !== undefined) {
        await loadMessages(selectedId);
      }
      setLoadState("idle");
    } catch {
      setLoadState("error");
    }
  }, [accessToken, api, loadMessages]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadThreads();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadThreads]);

  useEffect(() => {
    if (!accessToken) {
      return undefined;
    }

    let closed = false;
    let connection: { close: () => void } | undefined;
    let reconnectTimer: number | undefined;

    function open() {
      connection = connectMessengerRealtime({
        baseUrl: apiBaseUrl,
        accessToken,
        lastMessageId: cursorRef.current,
        onEvent: (event) => {
          dispatch({ type: "realtimeEventReceived", event });
          void markRead(event.message.thread_id, event.message.id);
        },
        onDisconnect: () => {
          if (closed) {
            return;
          }
          reconnectTimer = window.setTimeout(open, 1_000);
        },
      });
    }

    open();

    return () => {
      closed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      connection?.close();
    };
  }, [accessToken, apiBaseUrl, markRead]);

  async function handleSearch() {
    const query = searchQuery.trim();
    if (!query) {
      setHasSearched(false);
      dispatch({ type: "searchResultsLoaded", results: [] });
      return;
    }
    setIsSearching(true);
    try {
      const response = await api.GET("/api/messenger/search", {
        params: { query: { q: query, limit: 20 } },
      });
      dispatch({
        type: "searchResultsLoaded",
        results: response.data?.items ?? [],
      });
      setHasSearched(true);
    } finally {
      setIsSearching(false);
    }
  }

  async function openThreadComposer() {
    setIsComposingThread(true);
    setCreateError(undefined);
    setNewSubject("");
    setSelectedMemberIds([]);
    const response = await api
      .GET("/api/v1/users", { params: { query: { include_inactive: false } } })
      .catch(() => undefined);
    if (response?.data) {
      setMembers(
        response.data.filter((user) => user.id !== currentUserId),
      );
    }
  }

  function toggleMember(id: string) {
    setSelectedMemberIds((prev) =>
      prev.includes(id)
        ? prev.filter((value) => value !== id)
        : [...prev, id],
    );
  }

  async function handleCreateThread() {
    if (!branchId || selectedMemberIds.length === 0 || isCreatingThread) {
      if (selectedMemberIds.length === 0) {
        setCreateError(ko.messenger.participantsRequired);
      }
      return;
    }
    setCreateError(undefined);
    setIsCreatingThread(true);
    try {
      const subject = newSubject.trim();
      const response = await api.POST("/api/messenger/threads", {
        body: {
          branch_id: branchId,
          kind: selectedMemberIds.length > 1 ? "group" : "dm",
          title: subject.length > 0 ? subject : null,
          member_ids: selectedMemberIds,
        },
      });
      if (!response.data) {
        throw new Error("create messenger thread response missing data");
      }
      dispatch({ type: "threadCreated", thread: response.data });
      setIsComposingThread(false);
    } catch {
      setCreateError(ko.messenger.createFailed);
    } finally {
      setIsCreatingThread(false);
    }
  }

  async function handleSend() {
    if (!selectedThread || !composer.trim() || isSending) {
      return;
    }
    setSendError(undefined);
    setIsSending(true);
    try {
      const attachmentEvidenceIds = attachment
        ? [await uploadWorkOrderAttachment(selectedThread, attachment)]
        : [];
      const response = await api.POST(
        "/api/messenger/threads/{threadId}/messages",
        {
          params: { path: { threadId: selectedThread.id } },
          body: {
            body: composer.trim(),
            attachment_evidence_ids: attachmentEvidenceIds,
          },
        },
      );
      if (!response.data) {
        throw new Error("send messenger message response missing data");
      }
      dispatch({ type: "messageSent", message: response.data });
      await markRead(selectedThread.id, response.data.id);
      setComposer("");
      setAttachment(undefined);
    } catch {
      setSendError(ko.messenger.sendFailed);
    } finally {
      setIsSending(false);
    }
  }

  async function uploadWorkOrderAttachment(
    thread: MessengerThreadSummary,
    file: File,
  ) {
    if (!thread.work_order_id) {
      throw new Error("messenger attachment requires work order thread");
    }
    const presign = await api.POST("/api/v1/evidence/presign", {
      body: {
        work_order_id: thread.work_order_id,
        stage: "REPORT",
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
      },
    });
    if (!presign.data) {
      throw new Error("evidence presign response missing data");
    }
    const ticket: EvidencePresignResponse = {
      ...presign.data,
      upload: {
        ...presign.data.upload,
        headers: presign.data.upload.headers.map(
          ([name, value]) => [name, value] as [string, string],
        ),
      },
    };
    await putEvidenceUpload(ticket, file);
    await api.POST("/api/v1/evidence/{evidenceId}/confirm", {
      params: { path: { evidenceId: ticket.id } },
    });
    return ticket.id;
  }

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {ko.messenger.title}
          </h2>
          <p className="text-sm text-steel">{ko.messenger.messages}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => void openThreadComposer()}>
            <Plus aria-hidden="true" size={16} />
            {ko.messenger.newThread}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void loadThreads()}>
            <RefreshCw aria-hidden="true" size={16} />
            {ko.messenger.refresh}
          </Button>
        </div>
      </div>

      {loadState === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.messenger.readFailed}
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(220px,320px)_1fr]">
        <section className="grid content-start gap-3">
          <div className="flex items-center gap-2">
            <Input
              aria-label={ko.messenger.search}
              placeholder={ko.messenger.searchPlaceholder}
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.currentTarget.value);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              aria-label={ko.messenger.searchButton}
              onClick={() => void handleSearch()}
            >
              <Search aria-hidden="true" size={16} />
            </Button>
          </div>
          {isSearching ? (
            <p role="status" className="text-sm text-steel">
              {ko.messenger.searching}
            </p>
          ) : null}
          {!isSearching && hasSearched ? (
            <div className="grid gap-2">
              <h3 className="text-sm font-semibold text-steel">
                {ko.messenger.searchResults}
              </h3>
              {state.searchResults.length === 0 ? (
                <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                  {ko.messenger.searchEmpty}
                </p>
              ) : (
                state.searchResults.map((message) => (
                  <MessageRow key={`search-${message.id}`} message={message} />
                ))
              )}
            </div>
          ) : null}
          <h3 className="text-sm font-semibold text-steel">
            {ko.messenger.threads}
          </h3>
          {/* First load shows a skeleton so an in-flight fetch is not mistaken
              for an empty thread list (stale-while-revalidate on refetch). */}
          {loadState === "loading" && state.threads.length === 0 ? (
            <SkeletonCards count={4} lines={1} />
          ) : state.threads.length === 0 ? (
            <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
              {ko.messenger.emptyThreads}
            </p>
          ) : null}
          {state.threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={cn(
                "rounded-md border p-3 text-left transition hover:border-steel",
                state.selectedThreadId === thread.id
                  ? "border-ink bg-muted-panel ring-1 ring-signal"
                  : "border-line bg-white",
              )}
              aria-pressed={state.selectedThreadId === thread.id}
              onClick={() => {
                dispatch({ type: "threadSelected", threadId: thread.id });
                void loadMessages(thread.id);
              }}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">
                  {threadTitle(thread)}
                </span>
                <Badge>{ko.messenger.kinds[thread.kind]}</Badge>
              </span>
              <span className="mt-2 block text-sm text-steel">
                {thread.member_count}
                {ko.messenger.memberCount}
              </span>
            </button>
          ))}
        </section>

        <section className="grid min-h-[32rem] content-between gap-3 rounded-md border border-line p-3">
          {!selectedThread ? (
            <p className="self-center text-center text-sm text-steel">
              {ko.messenger.selectThread}
            </p>
          ) : (
            <>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-ink">
                    <MessageSquare aria-hidden="true" className="mr-2 inline" size={18} />
                    {threadTitle(selectedThread)}
                  </h3>
                  {state.nextCursorByThread[selectedThread.id] ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void loadMessages(
                          selectedThread.id,
                          state.nextCursorByThread[selectedThread.id],
                        );
                      }}
                    >
                      {ko.messenger.loadOlder}
                    </Button>
                  ) : null}
                </div>
                <div className="grid max-h-[26rem] gap-2 overflow-y-auto pr-1">
                  {selectedMessages.length === 0 ? (
                    <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
                      {ko.messenger.emptyMessages}
                    </p>
                  ) : null}
                  {selectedMessages.map((message) => (
                    <MessageRow key={message.id} message={message} />
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                {attachment ? (
                  <p className="text-sm text-steel">
                    {ko.messenger.attachmentReady}: {attachment.name}
                  </p>
                ) : null}
                {selectedThread.work_order_id ? (
                  <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-medium text-steel">
                    <Paperclip aria-hidden="true" size={16} />
                    {ko.messenger.attachment}
                    <input
                      className="sr-only"
                      type="file"
                      onChange={(event) => {
                        setAttachment(event.currentTarget.files?.[0]);
                      }}
                    />
                  </label>
                ) : null}
                <Textarea
                  ref={composerRef}
                  aria-label={ko.messenger.composer}
                  rows={1}
                  className="min-h-9 max-h-32 resize-none"
                  value={composer}
                  onChange={(event) => {
                    setComposer(event.currentTarget.value);
                  }}
                />
                {sendError ? (
                  <p role="alert" className="text-sm font-semibold text-red-700">
                    {sendError}
                  </p>
                ) : null}
                <Button
                  type="button"
                  disabled={!composer.trim() || isSending}
                  onClick={() => void handleSend()}
                >
                  <Send aria-hidden="true" size={16} />
                  {isSending ? ko.messenger.sending : ko.messenger.send}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>

      {isComposingThread ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ko.messenger.newThreadTitle}
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
        >
          <Card className="grid w-full max-w-md gap-4">
            <h2 className="text-lg font-semibold text-ink">
              {ko.messenger.newThreadTitle}
            </h2>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="new-thread-subject"
              >
                {ko.messenger.subject}
              </label>
              <Input
                id="new-thread-subject"
                value={newSubject}
                placeholder={ko.messenger.subjectPlaceholder}
                onChange={(event) => {
                  setNewSubject(event.currentTarget.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <span className="text-sm font-medium text-steel">
                {ko.messenger.participants}
              </span>
              <p className="text-xs text-steel">
                {ko.messenger.participantsHint}
              </p>
              <div className="grid max-h-56 gap-1 overflow-y-auto">
                {members.map((member) => (
                  <label
                    key={member.id}
                    className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMemberIds.includes(member.id)}
                      onChange={() => {
                        toggleMember(member.id);
                      }}
                    />
                    <span className="font-medium text-ink">
                      {member.display_name}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {createError ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {createError}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={isCreatingThread}
                onClick={() => {
                  setIsComposingThread(false);
                }}
              >
                {ko.messenger.createCancel}
              </Button>
              <Button
                type="button"
                disabled={isCreatingThread || selectedMemberIds.length === 0}
                onClick={() => void handleCreateThread()}
              >
                {isCreatingThread
                  ? ko.messenger.creating
                  : ko.messenger.create}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </Card>
  );
}

function MessageRow({ message }: { message: MessengerMessageSummary }) {
  return (
    <article className="rounded-md border border-line bg-white p-3">
      <p className="whitespace-pre-wrap text-sm text-ink">{message.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-steel">
        <time dateTime={message.sent_at}>
          {new Date(message.sent_at).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        {message.attachment_evidence_ids.length > 0 ? (
          <Badge>{ko.messenger.attachment}</Badge>
        ) : null}
      </div>
    </article>
  );
}

async function putEvidenceUpload(
  ticket: EvidencePresignResponse,
  file: File,
) {
  const uploadHeaders = Object.fromEntries(
    ticket.upload.headers.map(([name, value]) => [name, value]),
  );
  const response = await fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: uploadHeaders,
    body: file,
  });
  if (!response.ok) {
    throw new Error(`evidence upload failed with status ${String(response.status)}`);
  }
}
