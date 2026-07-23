import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated, usePolicyGate } from "../policy";
import { objDrag, useObjectDrop } from "../window";
import { MESSENGER_ACTIONS } from "./constants";
import { createMessengerConsoleApi } from "./MessengerConsoleApi";
import {
  applyComposerCandidate,
  buildComposerCandidates,
  buildMessageRows,
  extractObjectCodes,
  partitionThreads,
  renderMessageParts,
  threadTitle,
  unreadBadgeTotal,
  type ComposerCandidate,
  type MessagePart,
} from "./messengerModel";
import type {
  ConsoleMessengerMember,
  ConsoleMessengerMessage,
  ConsoleMessengerPresence,
  ConsoleMessengerThread,
  MessengerConsoleApi,
  TodoRef,
} from "./types";
import "../tokens.css";

type LoadState = "idle" | "loading" | "error" | "branch-required" | "target-unavailable";

type MessageMap = Record<string, ConsoleMessengerMessage[] | undefined>;
type CursorMap = Record<string, string | null | undefined>;
type PresenceMap = Record<string, ConsoleMessengerPresence[] | undefined>;
type TodoMap = Record<string, string | undefined>;

const T = ko.console.messenger;

export function MessengerConsoleScreen({
  accessToken,
  branchId,
  currentUserId,
  requestedThreadId,
  api,
}: {
  accessToken?: string;
  branchId?: string;
  currentUserId?: string;
  /** A URL/rail target. It is accepted only if the authenticated thread list
   * contains it and the caller can read it; no client-side ID grants access. */
  requestedThreadId?: string;
  api?: MessengerConsoleApi;
}) {
  const client = useMemo(() => api ?? createMessengerConsoleApi(accessToken), [accessToken, api]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [threads, setThreads] = useState<ConsoleMessengerThread[]>([]);
  const [members, setMembers] = useState<ConsoleMessengerMember[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [messagesByThread, setMessagesByThread] = useState<MessageMap>({});
  const [cursorByThread, setCursorByThread] = useState<CursorMap>({});
  const [presenceByThread, setPresenceByThread] = useState<PresenceMap>({});
  const [dividerUnreadByThread, setDividerUnreadByThread] = useState<Record<string, number | undefined>>({});
  const [todoByMessage, setTodoByMessage] = useState<TodoMap>({});
  const [threadQuery, setThreadQuery] = useState("");
  const [messageQuery, setMessageQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConsoleMessengerMessage[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [composer, setComposer] = useState("");
  const [quote, setQuote] = useState<ConsoleMessengerMessage>();
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [busyAction, setBusyAction] = useState<string>();
  const [statusChip, setStatusChip] = useState<string>();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  // Every route-target refresh owns a generation. A late response from an
  // earlier URL must never select, render, or mark a different conversation.
  const refreshGenerationRef = useRef(0);

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
  const selectedMessages = useMemo(
    () => (selectedThreadId ? (messagesByThread[selectedThreadId] ?? []) : []),
    [messagesByThread, selectedThreadId],
  );
  const objectCodes = useMemo(() => extractObjectCodes(selectedMessages), [selectedMessages]);
  const objectCodeSet = useMemo(() => new Set(objectCodes), [objectCodes]);
  const mentionSet = useMemo(
    () => new Set(members.map((member) => member.display_name)),
    [members],
  );
  const visibleThreads = useMemo(
    () => filterThreads(threads, threadQuery),
    [threads, threadQuery],
  );
  const threadGroups = useMemo(() => partitionThreads(visibleThreads), [visibleThreads]);
  const channels = useMemo(() => threads.filter((thread) => thread.visibility === "channel"), [threads]);
  const candidates = useMemo(
    () => buildComposerCandidates(composer, composer.length, { members, channels, objectCodes }),
    [channels, composer, members, objectCodes],
  );

  // §4-20/§4-23: the composer is an object drop target. A dropped object inserts
  // its bare code through the compose token grammar (renderMessageParts re-links
  // it), PBAC-gated — a code the user cannot open is a silent no-op (deny-by-
  // omission). Drop highlight is driven off the accept decision.
  const policyGate = usePolicyGate();
  const [objectDropActive, setObjectDropActive] = useState(false);
  const composerDrop = useObjectDrop({
    onRef: (ref) => {
      setComposer((prev) => appendObjectCode(prev, ref.code));
      setCandidateIndex(0);
    },
    canAccept: (code) => policyGate.can(MESSENGER_ACTIONS.objectOpen, { kind: "object", id: code }),
  });

  const loadThread = useCallback(
    async (
      thread: ConsoleMessengerThread,
      beforeMessageId?: string | null,
      generation = ++refreshGenerationRef.current,
    ) => {
      const isCurrent = () => refreshGenerationRef.current === generation;
      if (thread.visibility === "channel" && thread.joined === false) return;
      const [page, presence] = await Promise.all([
        client.listMessages(thread.id, beforeMessageId),
        client.listPresence(thread.id).catch(() => [] as ConsoleMessengerPresence[]),
      ]);
      if (!isCurrent()) return;
      setSelectedThreadId(thread.id);
      setDividerUnreadByThread((prev) =>
        prev[thread.id] === undefined ? { ...prev, [thread.id]: thread.unread_count } : prev,
      );
      setMessagesByThread((prev) => ({
        ...prev,
        [thread.id]: mergeMessages(prev[thread.id] ?? [], page.items),
      }));
      setCursorByThread((prev) => ({ ...prev, [thread.id]: page.next_cursor }));
      setPresenceByThread((prev) => ({ ...prev, [thread.id]: presence }));
      const newest = newestMessage(page.items);
      if (newest) {
        if (!isCurrent()) return;
        await client.markRead(thread.id, newest.id);
        if (!isCurrent()) return;
        setThreads((prev) =>
          prev.map((item) => (item.id === thread.id ? { ...item, unread_count: 0 } : item)),
        );
      }
    },
    [client],
  );

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const isCurrent = () => refreshGenerationRef.current === generation;
    if (!branchId) {
      if (!isCurrent()) return;
      setThreads([]);
      setMembers([]);
      setSelectedThreadId(undefined);
      setLoadState("branch-required");
      return;
    }
    setLoadState("loading");
    try {
      const memberThreads = await client.listThreads();
      if (!isCurrent()) return;
      const memberIds = new Set(memberThreads.map((thread) => thread.id));
      const [joinableChannels, branchMembers] = await Promise.all([
        client.listChannels().catch(() => [] as ConsoleMessengerThread[]),
        client.listMembers(branchId),
      ]);
      if (!isCurrent()) return;
      const merged = mergeThreads(
        memberThreads.map((thread) => ({ ...thread, joined: true })),
        joinableChannels.map((thread) => ({ ...thread, joined: memberIds.has(thread.id) })),
      );
      setThreads(merged);
      setMembers(branchMembers.filter((member) => member.id !== currentUserId));
      const currentSelectedThreadId = selectedThreadIdRef.current;
      const selectableThreads = merged.filter(
        (thread) => !(thread.visibility === "channel" && thread.joined === false),
      );
      // A URL target is authoritative for this refresh. Never fall through to
      // the previously open/default thread: a stale, deleted, unjoined, or
      // policy-filtered id must not cause a read receipt on an unrelated chat.
      const nextSelected = requestedThreadId !== undefined
        ? selectableThreads.find((thread) => thread.id === requestedThreadId)
        : selectableThreads.find((thread) => thread.id === currentSelectedThreadId) ??
          (selectableThreads.length > 0 ? selectableThreads[0] : undefined);
      if (!nextSelected) {
        if (!isCurrent()) return;
        setSelectedThreadId(undefined);
        setLoadState(requestedThreadId !== undefined ? "target-unavailable" : "idle");
        return;
      }
      await loadThread(nextSelected, undefined, generation);
      if (!isCurrent()) return;
      setLoadState("idle");
    } catch {
      if (!isCurrent()) return;
      setLoadState("error");
    }
  }, [branchId, client, currentUserId, loadThread, requestedThreadId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void refresh();
      }
    });
    return () => {
      cancelled = true;
      refreshGenerationRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const divider = pane.querySelector<HTMLElement>("[data-msgr-div]");
    pane.scrollTop = divider ? divider.offsetTop - pane.offsetTop : pane.scrollHeight;
  }, [selectedThreadId, selectedMessages.length]);

  async function handleJoin(thread: ConsoleMessengerThread) {
    setBusyAction(`join-${thread.id}`);
    try {
      const joined = await client.joinChannel(thread.id);
      const nextThread = { ...joined, joined: true };
      setThreads((prev) => mergeThreads(prev.filter((item) => item.id !== nextThread.id), [nextThread]));
      await loadThread(nextThread);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function handleSearch() {
    const query = messageQuery.trim();
    if (!query) {
      setHasSearched(false);
      setSearchResults([]);
      return;
    }
    setBusyAction("search");
    try {
      setSearchResults(await client.searchMessages(query));
      setHasSearched(true);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function handleSend() {
    if (!selectedThread || !composer.trim()) return;
    const body = composer.trim();
    setBusyAction("send");
    try {
      const sent = await client.sendMessage(selectedThread.id, {
        body,
        quoted_message_id: quote?.id ?? null,
      });
      setMessagesByThread((prev) => ({
        ...prev,
        [selectedThread.id]: mergeMessages(prev[selectedThread.id] ?? [], [sent]),
      }));
      setComposer("");
      setQuote(undefined);
      await client.markRead(selectedThread.id, sent.id).catch(() => undefined);
      setThreads((prev) =>
        prev.map((thread) => (thread.id === selectedThread.id ? { ...thread, unread_count: 0 } : thread)),
      );
    } finally {
      setBusyAction(undefined);
    }
  }

  async function handleAck(message: ConsoleMessengerMessage) {
    setBusyAction(`ack-${message.id}`);
    try {
      const ack = await client.toggleAck(message.id);
      updateMessage(ack.thread_id, ack.message_id, (item) => ({
        ...item,
        acked_by_me: ack.acked,
        ack_count: ack.ack_count,
      }));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function handleMute(thread: ConsoleMessengerThread) {
    setBusyAction(`mute-${thread.id}`);
    try {
      const result = await client.setMute(thread.id, !thread.muted);
      setThreads((prev) =>
        prev.map((item) => (item.id === result.thread_id ? { ...item, muted: result.muted } : item)),
      );
    } finally {
      setBusyAction(undefined);
    }
  }

  async function handleTodo(message: ConsoleMessengerMessage) {
    if (!selectedThread) return;
    setBusyAction(`todo-${message.id}`);
    try {
      const links: TodoRef[] = [
        { kind: "messenger_thread", id: selectedThread.id, label: threadTitle(selectedThread) },
        { kind: "messenger_message", id: message.id, label: message.body },
      ];
      const todo = await client.createTodo({ text: message.body, links });
      setTodoByMessage((prev) => ({ ...prev, [message.id]: todo.id }));
      setStatus(T.todo.done);
    } finally {
      setBusyAction(undefined);
    }
  }

  function updateMessage(
    threadId: string,
    messageId: string,
    updater: (message: ConsoleMessengerMessage) => ConsoleMessengerMessage,
  ) {
    setMessagesByThread((prev) => ({
      ...prev,
      [threadId]: (prev[threadId] ?? []).map((message) =>
        message.id === messageId ? updater(message) : message,
      ),
    }));
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCandidateIndex((index) => (index + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCandidateIndex((index) => (index + candidates.length - 1) % candidates.length);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        chooseCandidate(candidates[candidateIndex] ?? candidates[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCandidateIndex(0);
        setComposer((value) => value);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSend();
    }
  }

  function chooseCandidate(candidate: ComposerCandidate) {
    setComposer((value) => applyComposerCandidate(value, value.length, candidate));
    setCandidateIndex(0);
  }

  const selectedPresence = selectedThreadId ? (presenceByThread[selectedThreadId] ?? []) : [];
  const rows = buildMessageRows(selectedMessages, selectedThreadId ? (dividerUnreadByThread[selectedThreadId] ?? 0) : 0);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  return (
    <main className="console" data-console-screen="msgr" style={styles.root}>
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>{T.nav}</p>
          <h1 style={styles.title}>{T.title}</h1>
        </div>
        <div style={styles.headerChips}>
          <StatusChip tone="info">{T.badge(unreadBadgeTotal(threads))}</StatusChip>
          {loadState === "error" ? <StatusChip tone="danger" role="alert">{T.status.loadFailed}</StatusChip> : null}
          {loadState === "branch-required" ? (
            <StatusChip tone="danger" role="alert">{T.status.branchRequired}</StatusChip>
          ) : null}
          {loadState === "target-unavailable" ? (
            <StatusChip tone="danger" role="alert">{T.status.targetUnavailable}</StatusChip>
          ) : null}
          {statusChip ? <StatusChip tone="ok" role="status">{statusChip}</StatusChip> : null}
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={() => {
              void refresh();
            }}
          >
            {T.actions.refresh}
          </button>
        </div>
      </header>

      <div style={styles.layout}>
        <aside aria-label={T.sections.sidebar} style={styles.sidebar}>
          <input
            aria-label={T.search.threadLabel}
            type="search"
            value={threadQuery}
            onChange={(event) => {
              setThreadQuery(event.currentTarget.value);
            }}
            placeholder={T.search.threadPlaceholder}
            style={styles.input}
          />
          <ThreadSection
            title={T.sections.channels}
            threads={threadGroups.channels}
            selectedThreadId={selectedThreadId}
            onOpen={(thread) => {
              void loadThread(thread);
            }}
            onJoin={(thread) => {
              void handleJoin(thread);
            }}
            busyAction={busyAction}
            presenceByThread={presenceByThread}
          />
          <ThreadSection
            title={T.sections.directs}
            threads={threadGroups.directs}
            selectedThreadId={selectedThreadId}
            onOpen={(thread) => {
              void loadThread(thread);
            }}
            onJoin={(thread) => {
              void handleJoin(thread);
            }}
            busyAction={busyAction}
            presenceByThread={presenceByThread}
          />
        </aside>

        <section
          aria-label={selectedThread ? T.regions.conversation(threadTitle(selectedThread)) : T.regions.empty}
          role="region"
          style={styles.conversation}
        >
          {!selectedThread ? (
            <StatusChip tone="neutral">{loadState === "loading" ? T.status.loading : T.empty.thread}</StatusChip>
          ) : (
            <>
              <header style={styles.conversationHeader}>
                <div style={styles.threadTitleBlock}>
                  <h2 style={styles.threadTitle}>{threadTitle(selectedThread)}</h2>
                  <div style={styles.inlineChips}>
                    <StatusChip tone={selectedThread.visibility === "channel" ? "accent" : "info"}>
                      {selectedThread.visibility === "channel" ? T.visibility.channel : T.visibility.direct}
                    </StatusChip>
                    {selectedThread.muted ? <StatusChip tone="neutral">{T.status.muted}</StatusChip> : null}
                    {selectedPresence.map((presence) => (
                      <PolicyGated
                        key={presence.user_id}
                        action={MESSENGER_ACTIONS.memberRead}
                        resource={{ kind: "messenger_member", id: presence.user_id }}
                      >
                        <PresenceChip presence={presence} />
                      </PolicyGated>
                    ))}
                  </div>
                </div>
                <div style={styles.headerChips}>
                  {objectCodes.map((code) => (
                    <ObjectCodeButton key={code} code={code} />
                  ))}
                  <PolicyGated action={MESSENGER_ACTIONS.mute} resource={{ kind: "messenger_thread", id: selectedThread.id }}>
                    <button
                      type="button"
                      style={styles.secondaryButton}
                      disabled={busyAction === `mute-${selectedThread.id}`}
                      onClick={() => {
                        void handleMute(selectedThread);
                      }}
                    >
                      {selectedThread.muted ? T.actions.unmute : T.actions.mute}
                    </button>
                  </PolicyGated>
                </div>
              </header>

              <div style={styles.searchRow}>
                <input
                  aria-label={T.search.messageLabel}
                  type="search"
                  value={messageQuery}
                  onChange={(event) => {
                    setMessageQuery(event.currentTarget.value);
                  }}
                  placeholder={T.search.messagePlaceholder}
                  style={styles.input}
                />
                <PolicyGated action={MESSENGER_ACTIONS.search} resource={{ kind: "messenger_thread", id: selectedThread.id }}>
                  <button
                    type="button"
                    style={styles.secondaryButton}
                    onClick={() => {
                      void handleSearch();
                    }}
                  >
                    {busyAction === "search" ? T.actions.searching : T.actions.search}
                  </button>
                </PolicyGated>
              </div>
              {hasSearched ? (
                <div role="list" aria-label={T.sections.searchResults} style={styles.searchResults}>
                  {searchResults.map((message) => (
                    <button
                      key={message.id}
                      type="button"
                      role="listitem"
                      style={styles.searchResult}
                      onClick={() => {
                        const thread = threads.find((item) => item.id === message.thread_id);
                        if (thread) {
                          void loadThread(thread);
                        }
                      }}
                    >
                      {message.body}
                    </button>
                  ))}
                </div>
              ) : null}

              {cursorByThread[selectedThread.id] ? (
                <button
                  type="button"
                  style={styles.secondaryButton}
                  onClick={() => {
                    void loadThread(selectedThread, cursorByThread[selectedThread.id]);
                  }}
                >
                  {T.actions.loadOlder}
                </button>
              ) : null}

              <div ref={paneRef} style={styles.messagePane}>
                {rows.length === 0 ? <StatusChip tone="neutral">{T.empty.messages}</StatusChip> : null}
                {rows.map((row) => (
                  <MessageBubble
                    key={row.message.id}
                    row={row}
                    currentUserId={currentUserId}
                    authorizedObjectCodes={objectCodeSet}
                    authorizedMentions={mentionSet}
                    todoId={todoByMessage[row.message.id]}
                    onAck={handleAck}
                    onQuote={setQuote}
                    onTodo={handleTodo}
                    busyAction={busyAction}
                  />
                ))}
              </div>

              <footer style={styles.composerBox}>
                {quote ? (
                  <div style={styles.quotePreview}>
                    <span>{T.quote.preview(quote.quoted_sender_name ?? quote.sender_name ?? T.labels.unknown)} {quote.body}</span>
                    <button
                      type="button"
                      style={styles.textButton}
                      onClick={() => {
                        setQuote(undefined);
                      }}
                    >
                      {T.actions.cancelQuote}
                    </button>
                  </div>
                ) : null}
                <textarea
                  aria-label={T.composer.label}
                  value={composer}
                  rows={3}
                  onChange={(event) => {
                    setComposer(event.currentTarget.value);
                    setCandidateIndex(0);
                  }}
                  onKeyDown={handleComposerKeyDown}
                  onDragOver={(event) => {
                    composerDrop.onDragOver(event);
                    setObjectDropActive(event.defaultPrevented);
                  }}
                  onDragLeave={() => {
                    setObjectDropActive(false);
                  }}
                  onDrop={(event) => {
                    composerDrop.onDrop(event);
                    setObjectDropActive(false);
                  }}
                  placeholder={T.composer.placeholder}
                  style={objectDropActive ? styles.textareaDropActive : styles.textarea}
                />
                {candidates.length > 0 ? (
                  <div role="listbox" aria-label={T.composer.candidates} style={styles.candidateBox}>
                    {candidates.map((candidate, index) => (
                      <button
                        key={`${candidate.kind}-${candidate.label}`}
                        type="button"
                        role="option"
                        aria-selected={index === candidateIndex}
                        style={index === candidateIndex ? styles.candidateActive : styles.candidate}
                        onClick={() => {
                          chooseCandidate(candidate);
                        }}
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <PolicyGated action={MESSENGER_ACTIONS.send} resource={{ kind: "messenger_thread", id: selectedThread.id }}>
                  <button
                    type="button"
                    style={styles.primaryButton}
                    disabled={!composer.trim() || busyAction === "send"}
                    onClick={() => {
                      void handleSend();
                    }}
                  >
                    {busyAction === "send" ? T.actions.sending : T.actions.send}
                  </button>
                </PolicyGated>
              </footer>
            </>
          )}
        </section>
      </div>
    </main>
  );

  function setStatus(value: string) {
    setStatusChip(value);
    window.setTimeout(() => {
      setStatusChip(undefined);
    }, 1400);
  }
}

function ThreadSection({
  title,
  threads,
  selectedThreadId,
  onOpen,
  onJoin,
  busyAction,
  presenceByThread,
}: {
  title: string;
  threads: ConsoleMessengerThread[];
  selectedThreadId?: string;
  onOpen: (thread: ConsoleMessengerThread) => void;
  onJoin: (thread: ConsoleMessengerThread) => void;
  busyAction?: string;
  presenceByThread: PresenceMap;
}) {
  return (
    <section style={styles.threadSection}>
      <h3 style={styles.sectionTitle}>{title}</h3>
      {threads.length === 0 ? <StatusChip tone="neutral">{T.empty.section}</StatusChip> : null}
      {threads.map((thread) => {
        const selected = thread.id === selectedThreadId;
        const labelPrefix = thread.visibility === "channel" ? "# " : "";
        const titleText = `${labelPrefix}${threadTitle(thread)}`;
        const presence = presenceByThread[thread.id]?.[0];
        return (
          <PolicyGated key={thread.id} action={MESSENGER_ACTIONS.read} resource={{ kind: "messenger_thread", id: thread.id }}>
            <button
              type="button"
              aria-pressed={selected}
              aria-label={titleText}
              style={selected ? styles.threadButtonSelected : styles.threadButton}
              onClick={() => {
                onOpen(thread);
              }}
            >
              <span style={styles.threadButtonTop}>
                <span style={styles.threadName}>{titleText}</span>
                {thread.muted ? <span aria-label={T.status.muted}>◌</span> : null}
                {thread.unread_count > 0 && !thread.muted ? <StatusChip tone="accent">{String(thread.unread_count)}</StatusChip> : null}
              </span>
              <span style={styles.threadMeta}>
                {thread.member_count}{T.labels.members}
                {presence ? ` · ${T.presence[presence.status]}` : ""}
              </span>
            </button>
            {thread.visibility === "channel" && thread.joined === false ? (
              <PolicyGated action={MESSENGER_ACTIONS.join} resource={{ kind: "messenger_thread", id: thread.id }}>
                <button
                  type="button"
                  style={styles.textButton}
                  disabled={busyAction === `join-${thread.id}`}
                  onClick={() => {
                    onJoin(thread);
                  }}
                >
                  {T.actions.join}
                </button>
              </PolicyGated>
            ) : null}
          </PolicyGated>
        );
      })}
    </section>
  );
}

function MessageBubble({
  row,
  currentUserId,
  authorizedObjectCodes,
  authorizedMentions,
  todoId,
  onAck,
  onQuote,
  onTodo,
  busyAction,
}: {
  row: ReturnType<typeof buildMessageRows>[number];
  currentUserId?: string;
  authorizedObjectCodes: ReadonlySet<string>;
  authorizedMentions: ReadonlySet<string>;
  todoId?: string;
  onAck: (message: ConsoleMessengerMessage) => Promise<void>;
  onQuote: (message: ConsoleMessengerMessage) => void;
  onTodo: (message: ConsoleMessengerMessage) => Promise<void>;
  busyAction?: string;
}) {
  const mine = row.message.sender_id === currentUserId;
  const parts = renderMessageParts(row.message.body, { authorizedMentions, authorizedObjectCodes });
  return (
    <article style={mine ? styles.messageMine : styles.message}>
      {row.dividerBefore ? <div data-msgr-div style={styles.unreadDivider}>{T.status.unreadDivider}</div> : null}
      {row.headOn ? (
        <header style={styles.messageHeader}>
          <strong>{row.message.sender_name ?? T.labels.unknown}</strong>
          <time dateTime={row.message.sent_at}>{formatTime(row.message.sent_at)}</time>
        </header>
      ) : null}
      {row.message.quoted_message_id && row.message.quoted_body ? (
        <div style={styles.quoteBlock}>
          {row.message.quoted_sender_name ?? T.labels.unknown} · {row.message.quoted_body}
        </div>
      ) : null}
      <p style={styles.messageText}>{parts.map((part, index) => <MessagePartView key={`${part.kind}-${String(index)}`} part={part} />)}</p>
      <div style={styles.messageActions}>
        {row.message.read_target_count > 0 ? (
          <StatusChip tone="neutral">{T.readProgress(row.message.read_count, row.message.read_target_count)}</StatusChip>
        ) : null}
        {row.message.ack_count > 0 ? <StatusChip tone="ok">{T.ack.count(row.message.ack_count)}</StatusChip> : null}
        {todoId ? <StatusChip tone="info">{T.todo.done}</StatusChip> : null}
        <PolicyGated action={MESSENGER_ACTIONS.ack} resource={{ kind: "messenger_message", id: row.message.id }}>
          <button
            type="button"
            style={styles.actionButton}
            disabled={busyAction === `ack-${row.message.id}`}
            onClick={() => {
              void onAck(row.message);
            }}
          >
            {row.message.acked_by_me ? T.actions.unack : T.actions.ack}
          </button>
        </PolicyGated>
        <PolicyGated action={MESSENGER_ACTIONS.quote} resource={{ kind: "messenger_message", id: row.message.id }}>
          <button
            type="button"
            style={styles.actionButton}
            onClick={() => {
              onQuote(row.message);
            }}
          >
            {T.actions.quote}
          </button>
        </PolicyGated>
        <PolicyGated action={MESSENGER_ACTIONS.todo} resource={{ kind: "messenger_message", id: row.message.id }}>
          <button
            type="button"
            style={styles.actionButton}
            disabled={Boolean(todoId) || busyAction === `todo-${row.message.id}`}
            onClick={() => {
              void onTodo(row.message);
            }}
          >
            {T.actions.todo}
          </button>
        </PolicyGated>
      </div>
    </article>
  );
}

function MessagePartView({ part }: { part: MessagePart }) {
  if (part.kind === "text") return <>{part.text}</>;
  if (part.kind === "mention") return <span style={styles.mention}>{part.text}</span>;
  return <ObjectCodeButton code={part.code} fallback={part.text} />;
}

function ObjectCodeButton({ code, fallback }: { code: string; fallback?: string }) {
  return (
    <PolicyGated action={MESSENGER_ACTIONS.objectOpen} resource={{ kind: "object", id: code }} fallback={<span>{fallback ?? code}</span>}>
      <button type="button" {...objDrag(code, fallback ?? code)} style={styles.objectButton} aria-label={T.object.open(code)}>
        {code}
      </button>
    </PolicyGated>
  );
}

function PresenceChip({ presence }: { presence: ConsoleMessengerPresence }) {
  const tone = presence.status === "online" ? "ok" : presence.status === "away" ? "warn" : "neutral";
  return <StatusChip tone={tone}>{T.presence[presence.status]}</StatusChip>;
}

function mergeThreads(left: ConsoleMessengerThread[], right: ConsoleMessengerThread[]): ConsoleMessengerThread[] {
  const byId = new Map<string, ConsoleMessengerThread>();
  for (const thread of [...left, ...right]) {
    byId.set(thread.id, { ...byId.get(thread.id), ...thread });
  }
  return [...byId.values()].sort((a, b) => (b.last_message_at ?? b.updated_at).localeCompare(a.last_message_at ?? a.updated_at));
}

function mergeMessages(existing: ConsoleMessengerMessage[], incoming: ConsoleMessengerMessage[]): ConsoleMessengerMessage[] {
  const byId = new Map<string, ConsoleMessengerMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, normalizeMessage(message));
  return [...byId.values()].sort((a, b) => {
    const byTime = a.sent_at.localeCompare(b.sent_at);
    return byTime === 0 ? a.id.localeCompare(b.id) : byTime;
  });
}

function normalizeMessage(message: ConsoleMessengerMessage): ConsoleMessengerMessage {
  return {
    ...message,
    quoted_message_id: message.quoted_message_id ?? null,
    quoted_body: message.quoted_body ?? null,
    quoted_sender_name: message.quoted_sender_name ?? null,
  };
}

function newestMessage(messages: ConsoleMessengerMessage[]): ConsoleMessengerMessage | undefined {
  return [...messages].sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id)).at(-1);
}

function filterThreads(threads: ConsoleMessengerThread[], query: string): ConsoleMessengerThread[] {
  const trimmed = query.trim().toLocaleLowerCase("ko-KR");
  if (!trimmed) return threads;
  return threads.filter((thread) => threadTitle(thread).toLocaleLowerCase("ko-KR").includes(trimmed));
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

// A dropped object appends its bare code (space-separated) so the compose token
// grammar re-links it. No-op when the code is already the trailing token.
function appendObjectCode(value: string, code: string): string {
  const trimmed = value.replace(/\s+$/, "");
  if (trimmed.split(/\s/).at(-1) === code) return `${trimmed} `;
  return trimmed.length > 0 ? `${trimmed} ${code} ` : `${code} `;
}

const styles = {
  root: {
    minHeight: "100vh",
    padding: "var(--sp-6)",
    background: "var(--canvas)",
    color: "var(--ink)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-body)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: "var(--sp-4)",
    alignItems: "center",
    marginBottom: "var(--sp-5)",
  },
  eyebrow: {
    margin: 0,
    color: "var(--steel)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--fw-strong)",
    letterSpacing: "var(--tracking-label)",
  },
  title: {
    margin: 0,
    fontSize: "var(--text-h1)",
    letterSpacing: "var(--tracking-tight)",
  },
  headerChips: { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "var(--sp-2)", alignItems: "center" },
  layout: { display: "grid", gridTemplateColumns: "minmax(250px, 320px) minmax(0, 1fr)", gap: "var(--sp-4)" },
  sidebar: { display: "grid", alignContent: "start", gap: "var(--sp-3)" },
  threadSection: { display: "grid", gap: "var(--sp-2)" },
  sectionTitle: { margin: "var(--sp-2) 0 0", color: "var(--steel)", fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-label)" },
  input: {
    width: "100%",
    minHeight: 34,
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--surface)",
    color: "var(--ink)",
    padding: "0 var(--sp-3)",
    font: "inherit",
  },
  threadButton: {
    width: "100%",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-card)",
    background: "var(--surface)",
    color: "var(--ink)",
    padding: "var(--sp-4)",
    textAlign: "left",
    boxShadow: "var(--shadow)",
    cursor: "pointer",
  },
  threadButtonSelected: {
    width: "100%",
    border: "1px solid var(--signal)",
    borderRadius: "var(--radius-card)",
    background: "var(--accent-bg)",
    color: "var(--ink)",
    padding: "var(--sp-4)",
    textAlign: "left",
    boxShadow: "var(--shadow)",
    cursor: "pointer",
  },
  threadButtonTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)" },
  threadName: { fontWeight: "var(--fw-strong)" },
  threadMeta: { display: "block", marginTop: "var(--sp-1)", color: "var(--steel)", fontSize: "var(--text-xs)" },
  conversation: {
    minHeight: 620,
    display: "grid",
    gridTemplateRows: "auto auto auto minmax(0, 1fr) auto",
    gap: "var(--sp-3)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-card)",
    background: "var(--surface)",
    boxShadow: "var(--shadow)",
    padding: "var(--sp-5)",
  },
  conversationHeader: { display: "flex", justifyContent: "space-between", gap: "var(--sp-4)", alignItems: "start" },
  threadTitleBlock: { display: "grid", gap: "var(--sp-2)" },
  threadTitle: { margin: 0, fontSize: "var(--text-value-lg)", letterSpacing: "var(--tracking-tight)" },
  inlineChips: { display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" },
  searchRow: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "var(--sp-2)" },
  searchResults: { display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" },
  searchResult: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-chip)",
    background: "var(--muted)",
    color: "var(--ink)",
    padding: "var(--sp-1) var(--sp-2)",
    cursor: "pointer",
  },
  messagePane: { overflowY: "auto", display: "grid", alignContent: "start", gap: "var(--sp-2)", paddingRight: "var(--sp-1)" },
  message: {
    border: "1px solid var(--border-soft)",
    borderRadius: "var(--radius-card)",
    background: "var(--surface)",
    padding: "var(--sp-4)",
    display: "grid",
    gap: "var(--sp-2)",
  },
  messageMine: {
    border: "1px solid var(--info-bd)",
    borderRadius: "var(--radius-card)",
    background: "var(--info-bg)",
    padding: "var(--sp-4)",
    display: "grid",
    gap: "var(--sp-2)",
  },
  unreadDivider: {
    display: "grid",
    placeItems: "center",
    borderTop: "1px solid var(--signal)",
    color: "var(--accent-tx)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--fw-strong)",
    paddingTop: "var(--sp-2)",
  },
  messageHeader: { display: "flex", justifyContent: "space-between", gap: "var(--sp-2)", color: "var(--steel)", fontSize: "var(--text-xs)" },
  messageText: { margin: 0, whiteSpace: "pre-wrap", lineHeight: "var(--lh-base)" },
  messageActions: { display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" },
  quoteBlock: { borderLeft: "3px solid var(--signal)", paddingLeft: "var(--sp-2)", color: "var(--steel)", fontSize: "var(--text-xs)" },
  composerBox: { display: "grid", gap: "var(--sp-2)", position: "relative" },
  quotePreview: {
    display: "flex",
    justifyContent: "space-between",
    gap: "var(--sp-2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--muted)",
    padding: "var(--sp-2)",
    color: "var(--steel)",
    fontSize: "var(--text-xs)",
  },
  textarea: {
    minHeight: 78,
    resize: "vertical",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--surface)",
    color: "var(--ink)",
    padding: "var(--sp-3)",
    font: "inherit",
  },
  textareaDropActive: {
    minHeight: 78,
    resize: "vertical",
    border: "1px solid var(--signal)",
    borderRadius: "var(--radius)",
    background: "var(--surface)",
    color: "var(--ink)",
    padding: "var(--sp-3)",
    font: "inherit",
    boxShadow: "0 0 0 2px var(--accent-bg)",
  },
  candidateBox: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 82,
    display: "grid",
    gap: "var(--sp-1)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--surface)",
    boxShadow: "var(--shadow-pop)",
    padding: "var(--sp-2)",
    zIndex: 2,
  },
  candidate: {
    border: "1px solid transparent",
    borderRadius: "var(--radius-sm)",
    background: "var(--surface)",
    color: "var(--ink)",
    padding: "var(--sp-2)",
    textAlign: "left",
    cursor: "pointer",
  },
  candidateActive: {
    border: "1px solid var(--signal)",
    borderRadius: "var(--radius-sm)",
    background: "var(--accent-bg)",
    color: "var(--ink)",
    padding: "var(--sp-2)",
    textAlign: "left",
    cursor: "pointer",
  },
  primaryButton: {
    justifySelf: "end",
    border: "1px solid var(--signal)",
    borderRadius: "var(--radius)",
    background: "var(--signal)",
    color: "var(--ink)",
    padding: "var(--sp-2) var(--sp-5)",
    fontWeight: "var(--fw-strong)",
    cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--surface)",
    color: "var(--ink)",
    padding: "var(--sp-2) var(--sp-3)",
    fontWeight: "var(--fw-medium)",
    cursor: "pointer",
  },
  actionButton: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-chip)",
    background: "var(--muted)",
    color: "var(--ink)",
    padding: "var(--sp-1) var(--sp-2)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--fw-strong)",
    cursor: "pointer",
  },
  textButton: {
    border: "0",
    background: "transparent",
    color: "var(--info-tx)",
    padding: "var(--sp-1)",
    fontWeight: "var(--fw-strong)",
    cursor: "pointer",
  },
  objectButton: {
    border: "1px solid var(--info-bd)",
    borderRadius: "var(--radius-chip)",
    background: "var(--info-bg)",
    color: "var(--info-tx)",
    padding: "0 var(--sp-1)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--fw-strong)",
    cursor: "pointer",
  },
  mention: {
    color: "var(--teal)",
    fontWeight: "var(--fw-strong)",
  },
} satisfies Record<string, CSSProperties>;
