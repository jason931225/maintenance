import {
  ArrowLeft,
  Bell,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Mail,
  Maximize2,
  MessageSquare,
  PanelRightClose,
  Send,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type {
  MailThreadDetail,
  MessengerMessageSummary,
  MessengerThreadSummary,
} from "../../api/types";
import { useAuth } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { sanitizeMailHtml } from "../../lib/mailHtml";
import { publishNotificationCountsInvalidated } from "../../lib/notification-events";
import { cn, safeLabel } from "../../lib/utils";
import {
  FEATURES,
  hasAnyFeatureGrant,
  isNavItemVisible,
} from "../../components/shell/nav";
import { useMailSummary } from "../mail/useMailSummary";
import { notificationRoute } from "./notificationLink";
import type { NotificationSummary } from "./notificationsApi";
import {
  markAllNotificationsRead,
  markNotificationRead,
  useCommsStore,
  type RailSection,
} from "./store";
import { useCommsRuntime } from "./useCommsRuntime";

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (typeof window !== "undefined" ? window.location.origin : "");

// Stable empty reference so the thread selector returns an identity-equal value
// while a thread's messages are still loading (no spurious re-render).
const EMPTY_MESSAGES: MessengerMessageSummary[] = [];

interface Viewport {
  hidden: boolean;
  autoCollapsed: boolean;
  wide: boolean;
}

function readViewport(): Viewport {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  return { hidden: width < 768, autoCollapsed: width < 1280, wide: width >= 1560 };
}

function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  useEffect(() => {
    function onResize() {
      setViewport(readViewport());
    }
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return viewport;
}

function threadTitle(thread: MessengerThreadSummary): string {
  const title = thread.title?.trim();
  return title && title.length > 0 ? title : ko.messenger.untitled[thread.kind];
}

function UnreadPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-console-danger-solid px-1.5 text-[11px] font-bold leading-5 text-console-surface">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function CommsRail() {
  const { api, session } = useAuth();
  useCommsRuntime(api, session);

  const location = useLocation();
  const viewport = useViewport();

  const collapsedPref = useCommsStore((s) => s.collapsedPref);
  const openSection = useCommsStore((s) => s.openSection);
  const subview = useCommsStore((s) => s.subview);
  const setCollapsedPref = useCommsStore((s) => s.setCollapsedPref);
  const setSubview = useCommsStore((s) => s.setSubview);

  const collapsed = collapsedPref ?? viewport.autoCollapsed;

  const messengerGranted = isNavItemVisible(
    "messenger",
    session?.roles,
    session?.group_roles,
    session?.feature_grants,
  );
  const mailGranted = hasAnyFeatureGrant(session?.feature_grants, [FEATURES.MAIL_USE]);

  // Promotion: while the full module view owns the screen, its rail section
  // steps aside (the rail and the page share the same state — only the surface
  // differs).
  const messengerPromoted = location.pathname === "/messenger";
  const mailPromoted = location.pathname === "/mail";

  // Esc cascade: close a subview back to home, then collapse the rail. Consume
  // the event (preventDefault) so the shell's own Esc cascade — which bails on
  // defaultPrevented — does not also fire.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (subview.kind !== "home") {
        event.preventDefault();
        setSubview({ kind: "home" });
        return;
      }
      if (!collapsed) {
        event.preventDefault();
        setCollapsedPref(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [subview, collapsed, setCollapsedPref, setSubview]);

  if (viewport.hidden) return null;

  const width = collapsed
    ? "w-[54px]"
    : viewport.wide
      ? "w-[336px]"
      : "w-[300px]";

  return (
    <aside
      aria-label={ko.shell.commsRail.label}
      className={cn(
        "flex shrink-0 flex-col border-l border-console-border-soft bg-console-surface transition-[width] duration-[180ms] motion-reduce:transition-none",
        width,
      )}
    >
      {collapsed ? (
        <CollapsedStrip
          messengerVisible={messengerGranted && !messengerPromoted}
          mailVisible={mailGranted && !mailPromoted}
        />
      ) : (
        <OpenRail
          openSection={openSection}
          subview={subview}
          messengerVisible={messengerGranted && !messengerPromoted}
          mailVisible={mailGranted && !mailPromoted}
        />
      )}
    </aside>
  );
}

function CollapsedStrip({
  messengerVisible,
  mailVisible,
}: {
  messengerVisible: boolean;
  mailVisible: boolean;
}) {
  const messengerUnread = useCommsStore((s) => s.counts.messenger);
  const notificationUnread = useCommsStore((s) => s.notificationUnread);
  const setCollapsedPref = useCommsStore((s) => s.setCollapsedPref);
  const toggleSection = useCommsStore((s) => s.toggleSection);

  const open = (section: RailSection) => {
    setCollapsedPref(false);
    toggleSection(section);
  };

  return (
    <div className="flex flex-col items-center gap-1 py-2">
      {messengerVisible ? (
        <StripButton
          label={ko.shell.commsRail.openSection.messenger}
          unread={messengerUnread > 0}
          onClick={() => {
            open("messenger");
          }}
        >
          <MessageSquare size={18} aria-hidden="true" />
        </StripButton>
      ) : null}
      {mailVisible ? (
        <StripButton
          label={ko.shell.commsRail.openSection.mail}
          unread={false}
          onClick={() => {
            open("mail");
          }}
        >
          <Mail size={18} aria-hidden="true" />
        </StripButton>
      ) : null}
      <StripButton
        label={ko.shell.commsRail.openSection.notifications}
        unread={notificationUnread > 0}
        onClick={() => {
          open("notifications");
        }}
      >
        <Bell size={18} aria-hidden="true" />
      </StripButton>
    </div>
  );
}

function StripButton({
  label,
  unread,
  onClick,
  children,
}: {
  label: string;
  unread: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="relative flex h-[34px] w-[34px] items-center justify-center rounded-md text-console-steel hover:bg-console-muted hover:text-console-ink focus-visible:outline-2 focus-visible:outline-console-ink"
    >
      {children}
      {unread ? (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 h-[7px] w-[7px] rounded-full bg-console-danger-solid"
        />
      ) : null}
    </button>
  );
}

function OpenRail({
  openSection,
  subview,
  messengerVisible,
  mailVisible,
}: {
  openSection: RailSection;
  subview: ReturnType<typeof useCommsStore.getState>["subview"];
  messengerVisible: boolean;
  mailVisible: boolean;
}) {
  const setCollapsedPref = useCommsStore((s) => s.setCollapsedPref);

  if (subview.kind === "thread") {
    return <ThreadSubview threadId={subview.threadId} />;
  }
  if (subview.kind === "mail") {
    return <MailSubview threadId={subview.threadId} />;
  }

  // The open section may have been promoted away (its module owns the screen);
  // fall back to notifications so the rail always shows something actionable.
  const effectiveSection: RailSection =
    (openSection === "messenger" && !messengerVisible) ||
    (openSection === "mail" && !mailVisible)
      ? "notifications"
      : openSection;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end border-b border-console-border-soft px-2 py-1.5">
        <button
          type="button"
          aria-label={ko.shell.commsRail.collapse}
          onClick={() => {
            setCollapsedPref(true);
          }}
          className="flex h-8 w-8 items-center justify-center rounded-md text-console-steel hover:bg-console-muted hover:text-console-ink focus-visible:outline-2 focus-visible:outline-console-ink"
        >
          <PanelRightClose size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {messengerVisible ? (
          <MessengerSection open={effectiveSection === "messenger"} />
        ) : null}
        {mailVisible ? <MailSection open={effectiveSection === "mail"} /> : null}
        <NotificationsSection open={effectiveSection === "notifications"} />
      </div>
    </div>
  );
}

function SectionHeader({
  section,
  label,
  unread,
  open,
  extra,
}: {
  section: RailSection;
  label: string;
  unread: number;
  open: boolean;
  extra?: ReactNode;
}) {
  const toggleSection = useCommsStore((s) => s.toggleSection);
  return (
    <div className="flex items-center gap-1 px-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          toggleSection(section);
        }}
        className="flex flex-1 items-center gap-2 py-3 text-left text-sm font-semibold text-console-ink focus-visible:outline-2 focus-visible:outline-console-ink"
      >
        {open ? (
          <ChevronDown size={16} aria-hidden="true" className="text-console-faint" />
        ) : (
          <ChevronRight size={16} aria-hidden="true" className="text-console-faint" />
        )}
        <span>{label}</span>
        <UnreadPill count={unread} />
      </button>
      {open ? extra : null}
    </div>
  );
}

function MessengerSection({ open }: { open: boolean }) {
  const threads = useCommsStore((s) => s.messenger.threads);
  const unread = useCommsStore((s) => s.counts.messenger);
  const setSubview = useCommsStore((s) => s.setSubview);
  const dispatchMessenger = useCommsStore((s) => s.dispatchMessenger);

  return (
    <section className="border-b border-console-border-soft">
      <SectionHeader
        section="messenger"
        label={ko.shell.commsRail.sections.messenger}
        unread={unread}
        open={open}
      />
      {open ? (
        <div className="pb-2">
          {threads.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-console-faint">
              {ko.shell.commsRail.empty.messenger}
            </p>
          ) : (
            <ul>
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => {
                      dispatchMessenger({ type: "threadSelected", threadId: thread.id });
                      setSubview({ kind: "thread", threadId: thread.id });
                    }}
                    className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-console-muted focus-visible:outline-2 focus-visible:outline-console-ink"
                  >
                    <span className="truncate text-sm text-console-ink">
                      {threadTitle(thread)}
                    </span>
                    <UnreadPill count={Math.max(0, thread.unread_count)} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function MailSection({ open }: { open: boolean }) {
  const mailUnread = useCommsStore((s) => s.counts.mail);
  const setSubview = useCommsStore((s) => s.setSubview);
  const { threads, state } = useMailSummary(open);

  return (
    <section className="border-b border-console-border-soft">
      <SectionHeader
        section="mail"
        label={ko.shell.commsRail.sections.mail}
        unread={mailUnread}
        open={open}
      />
      {open ? (
        <div className="pb-2">
          {state === "unavailable" ? (
            <p className="px-3 pb-3 text-sm text-console-faint">
              {ko.shell.commsRail.mailUnavailable}
            </p>
          ) : state === "error" ? (
            <p role="alert" className="px-3 pb-3 text-sm text-console-danger-tx">
              {ko.shell.commsRail.loadFailed}
            </p>
          ) : threads.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-console-faint">
              {ko.shell.commsRail.empty.mail}
            </p>
          ) : (
            <ul>
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSubview({ kind: "mail", threadId: thread.id });
                    }}
                    className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-console-muted focus-visible:outline-2 focus-visible:outline-console-ink"
                  >
                    <span className="truncate text-sm text-console-ink">
                      {safeLabel(thread.subject)}
                    </span>
                    <UnreadPill count={Math.max(0, thread.unread_count)} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function NotificationsSection({ open }: { open: boolean }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const navigate = useNavigate();
  const notifications = useCommsStore((s) => s.notifications);
  const unread = useCommsStore((s) => s.notificationUnread);
  const setSubview = useCommsStore((s) => s.setSubview);

  const onNotificationClick = (notification: NotificationSummary) => {
    if (notification.unread) {
      void markNotificationRead(apiBaseUrl, token, notification.id);
    }
    setSubview({ kind: "home" });
    void navigate(notificationRoute(notification.link));
  };

  return (
    <section>
      <SectionHeader
        section="notifications"
        label={ko.shell.commsRail.sections.notifications}
        unread={unread}
        open={open}
        extra={
          unread > 0 ? (
            <button
              type="button"
              onClick={() => {
                void markAllNotificationsRead(apiBaseUrl, token);
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-console-steel hover:bg-console-muted hover:text-console-ink focus-visible:outline-2 focus-visible:outline-console-ink"
            >
              <CheckCheck size={14} aria-hidden="true" />
              {ko.shell.commsRail.markAllRead}
            </button>
          ) : null
        }
      />
      {open ? (
        <div className="pb-2">
          {notifications.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-console-faint">
              {ko.shell.commsRail.empty.notifications}
            </p>
          ) : (
            <ul>
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onNotificationClick(notification);
                    }}
                    className={cn(
                      "flex min-h-11 w-full flex-col gap-1 px-3 py-2 text-left hover:bg-console-muted focus-visible:outline-2 focus-visible:outline-console-ink",
                      notification.unread ? "bg-console-muted/40" : undefined,
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full border border-console-border-soft bg-console-muted px-2 py-0.5 text-[11px] font-medium text-console-steel">
                        {notification.category}
                      </span>
                      {notification.unread ? (
                        <span
                          aria-hidden="true"
                          className="h-[7px] w-[7px] rounded-full bg-console-danger-solid"
                        />
                      ) : null}
                    </span>
                    <span className="text-sm text-console-ink">{notification.text}</span>
                    <time
                      dateTime={notification.created_at}
                      className="text-[11px] text-console-faint"
                    >
                      {formatKoreanDateTime(notification.created_at)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SubviewHeader({ children }: { children?: ReactNode }) {
  const setSubview = useCommsStore((s) => s.setSubview);
  return (
    <div className="flex items-center gap-2 border-b border-console-border-soft px-2 py-1.5">
      <button
        type="button"
        aria-label={ko.shell.commsRail.back}
        onClick={() => {
          setSubview({ kind: "home" });
        }}
        className="flex h-8 w-8 items-center justify-center rounded-md text-console-steel hover:bg-console-muted hover:text-console-ink focus-visible:outline-2 focus-visible:outline-console-ink"
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </button>
      {children}
    </div>
  );
}

function ThreadSubview({ threadId }: { threadId: string }) {
  const { api, session } = useAuth();
  const currentUserId = session?.user_id;
  const thread = useCommsStore((s) =>
    s.messenger.threads.find((t) => t.id === threadId),
  );
  const messages = useCommsStore((s) =>
    threadId in s.messenger.messagesByThread
      ? s.messenger.messagesByThread[threadId]
      : EMPTY_MESSAGES,
  );
  const dispatchMessenger = useCommsStore((s) => s.dispatchMessenger);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);

  const markRead = useCallback(
    async (messageId: string) => {
      try {
        await api.PUT("/api/messenger/threads/{threadId}/read-receipt", {
          params: { path: { threadId } },
          body: { last_read_message_id: messageId },
        });
        dispatchMessenger({ type: "threadRead", threadId });
        publishNotificationCountsInvalidated();
      } catch {
        // read receipts are best-effort
      }
    },
    [api, dispatchMessenger, threadId],
  );

  useEffect(() => {
    let ignore = false;
    void Promise.resolve().then(async () => {
      try {
        const res = await api.GET("/api/messenger/threads/{threadId}/messages", {
          params: { path: { threadId }, query: { limit: 50 } },
        });
        if (!ignore && res.data) {
          dispatchMessenger({ type: "messagesPageLoaded", threadId, page: res.data });
          const newest = res.data.items.at(-1);
          if (newest) await markRead(newest.id);
        }
      } catch {
        // leave the thread empty on failure; the composer still works
      }
    });
    return () => {
      ignore = true;
    };
  }, [api, dispatchMessenger, markRead, threadId]);

  const handleSend = async () => {
    const body = composer.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const res = await api.POST("/api/messenger/threads/{threadId}/messages", {
        params: { path: { threadId } },
        body: { body, attachment_evidence_ids: [] },
      });
      if (res.data) {
        dispatchMessenger({ type: "messageSent", message: res.data });
        setComposer("");
        await markRead(res.data.id);
      }
    } catch {
      // keep the draft in the composer so the user can retry
    } finally {
      setSending(false);
    }
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    void handleSend();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SubviewHeader>
        <span className="truncate text-sm font-semibold text-console-ink">
          {thread ? threadTitle(thread) : ""}
        </span>
      </SubviewHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            mine={message.sender_id === currentUserId}
          />
        ))}
      </div>
      <div className="border-t border-console-border-soft p-2">
        <div className="flex items-end gap-2">
          <textarea
            aria-label={ko.shell.commsRail.composer}
            rows={1}
            value={composer}
            onChange={(event) => {
              setComposer(event.currentTarget.value);
            }}
            onKeyDown={onComposerKeyDown}
            className="max-h-24 min-h-9 flex-1 resize-none rounded-md border border-console-border bg-console-surface px-2 py-1.5 text-sm text-console-ink focus-visible:outline-2 focus-visible:outline-console-ink"
          />
          <button
            type="button"
            aria-label={ko.shell.commsRail.send}
            disabled={!composer.trim() || sending}
            onClick={() => {
              void handleSend();
            }}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-console-ink text-console-surface disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-console-ink"
          >
            <Send size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  mine,
}: {
  message: MessengerMessageSummary;
  mine: boolean;
}) {
  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm",
          mine
            ? "bg-console-ink text-console-surface"
            : "bg-console-muted text-console-ink",
        )}
      >
        {message.body}
      </div>
      <time dateTime={message.sent_at} className="mt-0.5 text-[10px] text-console-faint">
        {new Date(message.sent_at).toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
    </div>
  );
}

function MailSubview({ threadId }: { threadId: string }) {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<MailThreadDetail>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let ignore = false;
    void Promise.resolve().then(async () => {
      try {
        const res = await api.GET("/api/v1/mail/threads/{id}", {
          params: { path: { id: threadId } },
        });
        if (!ignore) {
          if (res.data) {
            setDetail(res.data);
            // Reading in the rail marks the thread seen, same as the full page.
            await api
              .PATCH("/api/v1/mail/threads/{id}/read-state", {
                params: { path: { id: threadId } },
                body: { seen: true },
              })
              .then(() => {
                publishNotificationCountsInvalidated();
              })
              .catch(() => undefined);
          } else {
            setFailed(true);
          }
        }
      } catch {
        if (!ignore) setFailed(true);
      }
    });
    return () => {
      ignore = true;
    };
  }, [api, threadId]);

  const latest = detail?.messages.at(-1);
  const bodyHtml = latest?.body_html;
  const sanitizedHtml = bodyHtml ? sanitizeMailHtml(bodyHtml) : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SubviewHeader>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            void navigate("/mail");
          }}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-console-steel hover:bg-console-muted hover:text-console-ink focus-visible:outline-2 focus-visible:outline-console-ink"
        >
          <Maximize2 size={14} aria-hidden="true" />
          {ko.shell.commsRail.openFull}
        </button>
      </SubviewHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {failed ? (
          <p role="alert" className="text-sm text-console-danger-tx">
            {ko.shell.commsRail.loadFailed}
          </p>
        ) : !detail || !latest ? null : (
          <>
            <h2 className="text-sm font-semibold text-console-ink">
              {safeLabel(detail.subject)}
            </h2>
            <p className="mt-1 text-xs text-console-steel">
              {safeLabel(latest.from_name, latest.from_address)}
            </p>
            <time
              dateTime={latest.received_at}
              className="text-[11px] text-console-faint"
            >
              {formatKoreanDateTime(latest.received_at)}
            </time>
            <div className="mt-3 text-sm text-console-ink">
              {sanitizedHtml.trim().length > 0 ? (
                <div
                  className="mail-body break-words"
                  // Sanitized at the render boundary by DOMPurify (sanitizeMailHtml).
                  // Do not swap for a custom sanitizer; body_html is untrusted.
                  dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words">
                  {latest.body_text ?? latest.snippet}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
