import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { ko } from "../../i18n/ko";
import { useAuth } from "../../context/auth";
import type { SendMailRequest } from "../../api/types";
import { PolicyGated } from "../policy";
import "../tokens.css";
import "./mail.css";
import {
  forwardMail,
  getMailAccount,
  getMailAttachmentDownload,
  getMailThread,
  listMailFolders,
  listMailThreads,
  replyMail,
  sendMail,
  setMailThreadReadState,
} from "./api";
import {
  buildThreadReferences,
  fileToMailAttachment,
  forwardSubject,
  isValidEmail,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  originalMessageBlock,
  parseRecipients,
  replyRecipients,
  replySubject,
  safeAttachmentDownloadUrl,
  totalAttachmentBytes,
} from "./format";
import { MailComposer } from "./MailComposer";
import { MailFolderPane } from "./MailFolderPane";
import { MAIL_ACTIONS } from "./mailScreenConfig";
import { MailReadPane } from "./MailReadPane";
import { MailThreadList } from "./MailThreadList";
import { alertStyle, headerStyle, rootStyle, statusRowStyle, successStyle, surfaceStyle, titleStyle } from "./styles";
import type {
  ConsoleMailAttachment,
  ConsoleMailFolder,
  ConsoleMailMessage,
  ConsoleMailThread,
  ConsoleMailThreadDetail,
  MailClassification,
  MailComposerState,
  MailEgressBlock,
  MailEgressReason,
} from "./types";

const EMPTY_COMPOSE: MailComposerState = {
  mode: "new",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
  references: [],
  classification: "normal",
};

type LoadState = "loading" | "ready" | "empty" | "error" | "unavailable" | "not_configured";
type ResponsiveMailView = "master" | "detail" | "compose";
type MailRouteUpdate = {
  folderId?: string | undefined;
  threadId?: string | undefined;
  view?: ResponsiveMailView;
};

function responsiveMailView(value: string | null): ResponsiveMailView {
  return value === "detail" || value === "compose" ? value : "master";
}

function parsedMailRoute(search: string): Required<Pick<MailRouteUpdate, "view">> & MailRouteUpdate {
  const params = new URLSearchParams(search);
  return {
    folderId: params.get("mail_folder")?.trim() || undefined,
    threadId: params.get("mail_thread")?.trim() || undefined,
    view: responsiveMailView(params.get("mail_view")),
  };
}

function hasExternalRecipient(values: string[]): boolean {
  return values.some((address) => {
    const domain = address.split("@")[1]?.toLowerCase() ?? "";
    return domain.length > 0 && domain !== "cossok.com" && domain !== "knllogistic.com";
  });
}

function blockedEgress(
  compose: MailComposerState,
  attachments: File[],
): MailEgressBlock | undefined {
  const recipientAddresses = parseRecipients([compose.to, compose.cc, compose.bcc].join(",")).map((item) => item.address);
  const reasons: MailEgressReason[] = [];
  const hasRiskyPayload =
    attachments.length > 0 ||
    compose.classification === "sensitive" ||
    compose.classification === "quarantine";
  if (hasRiskyPayload && hasExternalRecipient(recipientAddresses)) reasons.push("externalRecipient");
  if (attachments.length > 0) reasons.push("unapprovedAttachment");
  if (compose.classification === "sensitive" || compose.classification === "quarantine") reasons.push("sensitiveClassification");

  if (reasons.length === 0) return undefined;
  if (reasons.includes("unapprovedAttachment")) return { reasons, nextAction: "removeAttachment" };
  if (reasons.includes("sensitiveClassification")) return { reasons, nextAction: "requestApproval" };
  if (reasons.includes("litigationHold")) return { reasons, nextAction: "openLifecycle" };
  return { reasons, nextAction: "notifyCompliance" };
}

export function MailScreen() {
  const { api } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const T = ko.console.mail;
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [folders, setFolders] = useState<ConsoleMailFolder[]>([]);
  const [threads, setThreads] = useState<ConsoleMailThread[]>([]);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [detail, setDetail] = useState<ConsoleMailThreadDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [compose, setCompose] = useState<MailComposerState>(EMPTY_COMPOSE);
  const [composeAttachments, setComposeAttachments] = useState<File[]>([]);
  const [pendingGeneration, setPendingGeneration] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [egressBlock, setEgressBlock] = useState<MailEgressBlock>();
  const [folderNavOpen, setFolderNavOpen] = useState(false);
  const folderTriggerRef = useRef<HTMLButtonElement>(null);
  const folderCloseRef = useRef<HTMLButtonElement>(null);
  const folderNavRef = useRef<HTMLElement>(null);
  const threadListRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composeGenerationRef = useRef(0);
  const [composeGeneration, setComposeGeneration] = useState(0);
  const advanceComposeGeneration = useCallback(() => {
    const nextGeneration = composeGenerationRef.current + 1;
    composeGenerationRef.current = nextGeneration;
    setComposeGeneration(nextGeneration);
  }, []);
  const route = useMemo(() => parsedMailRoute(location.search), [location.search]);
  const folderId = route.folderId;
  const responsiveView = route.view;
  const selectedThreadId = route.threadId
    ? threads.some((thread) => thread.id === route.threadId) ? route.threadId : undefined
    : threads[0]?.id;
  const sending = pendingGeneration === composeGeneration;

  const updateMailRoute = useCallback((updates: MailRouteUpdate, options: { replace?: boolean; focus?: "master" | "content"; preserveActiveFocus?: boolean } = {}) => {
    const params = new URLSearchParams(location.search);
    if ("folderId" in updates) {
      if (updates.folderId) params.set("mail_folder", updates.folderId);
      else params.delete("mail_folder");
    }
    if ("threadId" in updates) {
      if (updates.threadId) params.set("mail_thread", updates.threadId);
      else params.delete("mail_thread");
    }
    if ("view" in updates) params.set("mail_view", updates.view ?? "master");
    const search = params.toString();
    void navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: options.replace },
    );
    if (options.focus) {
      const focusOrigin = document.activeElement;
      window.requestAnimationFrame(() => {
        if (options.preserveActiveFocus && document.activeElement !== focusOrigin) return;
        (options.focus === "master" ? threadListRef.current : contentRef.current)?.focus();
      });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  const setMailView = useCallback((view: ResponsiveMailView) => {
    updateMailRoute({ view }, { focus: view === "master" ? "master" : "content", preserveActiveFocus: true });
  }, [updateMailRoute]);

  const closeFolderNav = useCallback(() => {
    setFolderNavOpen(false);
    window.requestAnimationFrame(() => { folderTriggerRef.current?.focus(); });
  }, []);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId),
    [selectedThreadId, threads],
  );
  const loadMailbox = useCallback(async () => {
    setLoadState("loading");
    setError(undefined);
    const queryParams: { folder?: string; unread?: boolean; q?: string; limit: number } = { limit: 50 };
    if (folderId) queryParams.folder = folderId;
    if (unreadOnly) queryParams.unread = true;
    if (query.trim()) queryParams.q = query.trim();
    try {
      const [accountRes, folderRes, threadRes] = await Promise.all([
        getMailAccount(api).catch(() => undefined),
        listMailFolders(api),
        listMailThreads(api, queryParams),
      ]);
      if (accountRes?.response.status === 503 || folderRes.response.status === 503 || threadRes.response.status === 503) {
        setLoadState("unavailable");
        setFolders([]);
        setThreads([]);
        setDetail(undefined);
        return;
      }
      if (accountRes?.response.status === 204) {
        setLoadState("not_configured");
        setFolders([]);
        setThreads([]);
        setDetail(undefined);
        return;
      }
      if (!folderRes.data || !threadRes.data) {
        setLoadState("error");
        return;
      }
      const nextThreads = threadRes.data;
      setFolders(folderRes.data);
      setThreads(nextThreads);
      setLoadState(nextThreads.length > 0 ? "ready" : "empty");
    } catch {
      setLoadState("error");
    }
  }, [api, folderId, query, unreadOnly]);

  useEffect(() => {
    void Promise.resolve().then(loadMailbox);
  }, [loadMailbox]);

  useEffect(() => {
    if (!route.threadId || (loadState !== "ready" && loadState !== "empty")) return;
    if (threads.some((thread) => thread.id === route.threadId)) return;
    updateMailRoute(
      threads[0]
        ? { threadId: threads[0].id }
        : { threadId: undefined, view: "master" },
      { replace: true },
    );
  }, [loadState, route.threadId, threads, updateMailRoute]);

  useEffect(() => {
    if (!folderNavOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFolderNav();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(folderNavRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const onFocusIn = (event: FocusEvent) => {
      if (!folderNavRef.current?.contains(event.target as Node)) folderCloseRef.current?.focus();
    };
    window.addEventListener("focusin", onFocusIn);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("focusin", onFocusIn); };
  }, [closeFolderNav, folderNavOpen]);

  useEffect(() => {
    let ignore = false;
    void Promise.resolve().then(async () => {
      if (!selectedThreadId) {
        if (!ignore) setDetail(undefined);
        return;
      }
      if (!ignore) setDetailLoading(true);
      try {
        const data = await getMailThread(api, selectedThreadId);
        if (!ignore) setDetail(data);
      } catch {
        if (!ignore) setDetail(undefined);
      } finally {
        if (!ignore) setDetailLoading(false);
      }
    });
    return () => {
      ignore = true;
    };
  }, [api, selectedThreadId]);

  const updateCompose = useCallback(
    <K extends keyof MailComposerState>(key: K, value: MailComposerState[K]) => {
      advanceComposeGeneration();
      setCompose((prev) => ({ ...prev, [key]: value }));
      setEgressBlock(undefined);
    },
    [advanceComposeGeneration],
  );

  const resetCompose = useCallback(() => {
    advanceComposeGeneration();
    setCompose(EMPTY_COMPOSE);
    setComposeAttachments([]);
    setEgressBlock(undefined);
  }, [advanceComposeGeneration]);

  const setThreadSeen = useCallback(
    async (threadId: string, seen: boolean) => {
      setNotice(undefined);
      setError(undefined);
      const { error: apiError } = await setMailThreadReadState(api, threadId, seen).catch(() => ({ error: true }) as const);
      if (apiError) {
        setError(T.read.readStateFailed);
        return;
      }
      setThreads((prev) =>
        prev.map((thread) =>
          thread.id === threadId
            ? { ...thread, unread_count: seen ? 0 : Math.max(1, thread.unread_count) }
            : thread,
        ),
      );
      setDetail((prev) =>
        prev?.id === threadId
          ? {
              ...prev,
              messages: prev.messages.map((message) =>
                message.direction === "IN" ? { ...message, seen } : message,
              ),
            }
          : prev,
      );
      setNotice(seen ? T.read.markedRead : T.read.markedUnread);
    },
    [api, T.read.markedRead, T.read.markedUnread, T.read.readStateFailed],
  );

  const openThread = useCallback(
    (thread: ConsoleMailThread) => {
      updateMailRoute({ threadId: thread.id, view: "detail" }, { focus: "content" });
      if (thread.unread_count > 0) void setThreadSeen(thread.id, true);
    },
    [setThreadSeen, updateMailRoute],
  );

  const startThreadedCompose = useCallback(
    (mode: "reply" | "forward", message: ConsoleMailMessage) => {
      const parentMessageId = message.message_id?.trim();
      if (!parentMessageId) {
        setError(T.composer.validation.threadingUnavailable);
        return;
      }
      const subject = message.subject || selectedThread?.subject || T.thread.noSubject;
      setNotice(undefined);
      setError(undefined);
      setEgressBlock(undefined);
      advanceComposeGeneration();
      setCompose({
        mode,
        to: mode === "reply" ? replyRecipients(message) : "",
        cc: "",
        bcc: "",
        subject: mode === "reply" ? replySubject(subject) : forwardSubject(subject),
        body: mode === "forward" ? originalMessageBlock(message, subject) : "",
        inReplyTo: parentMessageId,
        references: buildThreadReferences(message),
        classification: "normal",
      });
      setComposeAttachments([]);
      updateMailRoute({ view: "compose" }, { focus: "content", preserveActiveFocus: true });
    },
    [T.composer.validation.threadingUnavailable, T.thread.noSubject, advanceComposeGeneration, selectedThread?.subject, updateMailRoute],
  );

  const closeCompose = useCallback(() => {
    resetCompose();
    updateMailRoute({ view: selectedThread ? "detail" : "master" }, { focus: selectedThread ? "content" : "master" });
  }, [resetCompose, selectedThread, updateMailRoute]);

  const sendCurrentMail = useCallback(async () => {
    setNotice(undefined);
    setError(undefined);
    setEgressBlock(undefined);
    const recipients = parseRecipients(compose.to);
    const cc = parseRecipients(compose.cc);
    const bcc = parseRecipients(compose.bcc);
    const allRecipients = [...recipients, ...cc, ...bcc];
    if (recipients.length === 0 || allRecipients.some((recipient) => !isValidEmail(recipient.address))) {
      setError(T.composer.validation.to);
      return;
    }
    if (!compose.subject.trim()) {
      setError(T.composer.validation.subject);
      return;
    }
    if (!compose.body.trim()) {
      setError(T.composer.validation.body);
      return;
    }
    if (compose.mode !== "new" && !compose.inReplyTo) {
      setError(T.composer.validation.threadingUnavailable);
      return;
    }
    if (totalAttachmentBytes(composeAttachments) > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      setError(T.composer.validation.attachments);
      return;
    }
    const block = blockedEgress(compose, composeAttachments);
    if (block) {
      setEgressBlock(block);
      return;
    }
    const sendingGeneration = composeGenerationRef.current;
    setPendingGeneration(sendingGeneration);
    try {
      const attachments = composeAttachments.length > 0
        ? await Promise.all(composeAttachments.map(fileToMailAttachment))
        : undefined;
      const requestBody: SendMailRequest = {
        to: recipients,
        subject: compose.subject.trim(),
        body_text: compose.body.trim(),
      };
      if (cc.length > 0) requestBody.cc = cc;
      if (bcc.length > 0) requestBody.bcc = bcc;
      if (attachments) requestBody.attachments = attachments;
      if (compose.mode !== "new") {
        requestBody.in_reply_to = compose.inReplyTo;
        requestBody.references = compose.references;
      }
      const response = compose.mode === "reply"
        ? await replyMail(api, requestBody)
        : compose.mode === "forward"
          ? await forwardMail(api, requestBody)
          : await sendMail(api, requestBody);
      const stillCurrent = composeGenerationRef.current === sendingGeneration;
      if (!response.data) {
        if (stillCurrent) {
          if (response.response.status === 503) setLoadState("unavailable");
          setError(compose.mode === "reply" ? T.composer.replyFailed : compose.mode === "forward" ? T.composer.forwardFailed : T.composer.failed);
        }
        return;
      }
      if (stillCurrent) {
        setNotice(compose.mode === "reply" ? T.composer.replySent : compose.mode === "forward" ? T.composer.forwardSent : T.composer.sent);
        resetCompose();
      }
    } catch {
      if (composeGenerationRef.current === sendingGeneration) setError(compose.mode === "reply" ? T.composer.replyFailed : compose.mode === "forward" ? T.composer.forwardFailed : T.composer.failed);
    } finally {
      setPendingGeneration((current) => current === sendingGeneration ? undefined : current);
    }
  }, [api, compose, composeAttachments, resetCompose, T]);

  const openAttachment = useCallback(
    async (attachment: ConsoleMailAttachment) => {
      setError(undefined);
      const { data } = await getMailAttachmentDownload(api, attachment.id).catch(() => ({ data: undefined }) as const);
      if (!data?.url) {
        setError(T.attachment.downloadFailed);
        return;
      }
      const safeUrl = safeAttachmentDownloadUrl(data.url);
      if (!safeUrl) {
        setError(T.attachment.downloadFailed);
        return;
      }
      window.open(safeUrl, "_blank", "noopener,noreferrer");
    },
    [api, T.attachment.downloadFailed],
  );

  const content = loadState === "loading" ? (
    <div role="status" style={statusRowStyle}>{T.state.loading}</div>
  ) : loadState === "error" ? (
    <div role="alert" style={statusRowStyle}>
      {T.state.loadFailed}
      <button type="button" style={{ marginLeft: "var(--sp-3)" }} onClick={() => { void loadMailbox(); }}>
        {T.state.retry}
      </button>
    </div>
  ) : loadState === "unavailable" ? (
    <div role="status" style={statusRowStyle}>
      <strong>{T.state.unavailableTitle}</strong>
      <p>{T.state.unavailable}</p>
    </div>
  ) : loadState === "not_configured" ? (
    <div role="status" style={statusRowStyle}>
      <strong>{T.state.notConfiguredTitle}</strong>
      <p>{T.state.notConfigured}</p>
    </div>
  ) : (
    <div className="mail-screen__frame">
      <div
        className="mail-screen__surface"
        data-testid="mail-responsive-surface"
        data-mail-view={responsiveView}
        data-folder-open={folderNavOpen ? "true" : "false"}
        style={surfaceStyle}
      >
      <MailFolderPane
        folders={folders}
        selectedFolderId={folderId}
        onClose={closeFolderNav}
        closeButtonRef={folderCloseRef}
        drawerOpen={folderNavOpen}
        folderNavRef={folderNavRef}
        onSelectFolder={(nextFolderId) => {
          setDetail(undefined);
          setFolderNavOpen(false);
          updateMailRoute({ folderId: nextFolderId, threadId: undefined, view: "master" }, { focus: "master" });
        }}
      />
      <MailThreadList
        threads={threads}
        selectedThreadId={selectedThreadId}
        queryDraft={queryDraft}
        unreadOnly={unreadOnly}
        loadState={loadState}
        onQueryDraftChange={setQueryDraft}
        onSubmitSearch={() => { setQuery(queryDraft); }}
        onUnreadOnlyChange={setUnreadOnly}
        onSelectThread={(thread) => { updateMailRoute({ threadId: thread.id }); }}
        onOpenThread={openThread}
        onOpenFolders={() => {
          setFolderNavOpen(true);
          window.requestAnimationFrame(() => { folderCloseRef.current?.focus(); });
        }}
        onCompose={() => { setMailView("compose"); }}
        folderNavOpen={folderNavOpen}
        folderTriggerRef={folderTriggerRef}
        threadListRef={threadListRef}
        backgroundInert={folderNavOpen}
      />
      <div ref={contentRef} className="mail-screen__content" aria-hidden={folderNavOpen || undefined} inert={folderNavOpen || undefined} style={{ display: "grid", minWidth: 0, alignContent: "start" }} tabIndex={-1}>
        <div className="mail-screen__mobile-navigation" aria-label={T.title}>
          <button type="button" style={{ minHeight: "calc(var(--sp-6) * 2)" }} onClick={() => { setMailView("master"); }}>
            {T.responsive.backToThreads}
          </button>
          <button type="button" style={{ minHeight: "calc(var(--sp-6) * 2)" }} onClick={() => { setMailView("compose"); }}>
            {T.responsive.compose}
          </button>
        </div>
        <MailReadPane
          selectedThread={selectedThread}
          detail={detail}
          detailLoading={detailLoading}
          onMarkSeen={(seen) => {
            if (selectedThread) void setThreadSeen(selectedThread.id, seen);
          }}
          onReply={(message) => { startThreadedCompose("reply", message); }}
          onForward={(message) => { startThreadedCompose("forward", message); }}
          onDownloadAttachment={(attachment) => { void openAttachment(attachment); }}
        />
        <div className="mail-screen__composer" style={{ padding: "0 var(--sp-5) var(--sp-5)" }}>
          <MailComposer
            compose={compose}
            attachments={composeAttachments}
            sending={sending}
            egressBlock={egressBlock}
            onComposeChange={updateCompose}
            onClassificationChange={(classification: MailClassification) => { updateCompose("classification", classification); }}
            onFilesSelected={(files) => { advanceComposeGeneration(); setComposeAttachments((prev) => [...prev, ...files]); setEgressBlock(undefined); }}
            onRemoveAttachment={(file) => { advanceComposeGeneration(); setComposeAttachments((prev) => prev.filter((item) => item !== file)); setEgressBlock(undefined); }}
            onSubmit={() => { void sendCurrentMail(); }}
            onCancelThread={closeCompose}
          />
        </div>
      </div>
      </div>
    </div>
  );

  return (
    <PolicyGated action={MAIL_ACTIONS.read} resource={{ kind: "mail_screen" }}>
      <main className="console mail-screen__root" style={rootStyle}>
        <header aria-hidden={folderNavOpen || undefined} inert={folderNavOpen || undefined} style={headerStyle}>
          <h1 style={titleStyle}>{T.title}</h1>
          <button type="button" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface)", color: "var(--ink)", padding: "0 var(--sp-4)", minHeight: "calc(var(--sp-6) * 2)", fontFamily: "var(--font-sans)", fontWeight: "var(--fw-strong)" }} onClick={() => { if (!folderNavOpen) void loadMailbox(); }}>
            {T.state.refresh}
          </button>
        </header>
        {folderNavOpen ? <div className="mail-screen__folder-backdrop" aria-hidden="true" onClick={closeFolderNav} /> : null}
        {notice ? <div role="status" style={successStyle}>{notice}</div> : null}
        {error ? <div role="alert" style={alertStyle}>{error}</div> : null}
        {content}
      </main>
    </PolicyGated>
  );
}
