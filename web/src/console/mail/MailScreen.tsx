import { useCallback, useEffect, useMemo, useState } from "react";

import { ko } from "../../i18n/ko";
import { useAuth } from "../../context/auth";
import type { SendMailRequest } from "../../api/types";
import { PolicyGated } from "../policy";
import "../tokens.css";
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
  const T = ko.console.mail;
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [folders, setFolders] = useState<ConsoleMailFolder[]>([]);
  const [threads, setThreads] = useState<ConsoleMailThread[]>([]);
  const [folderId, setFolderId] = useState<string>();
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [detail, setDetail] = useState<ConsoleMailThreadDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [compose, setCompose] = useState<MailComposerState>(EMPTY_COMPOSE);
  const [composeAttachments, setComposeAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [egressBlock, setEgressBlock] = useState<MailEgressBlock>();

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
        setSelectedThreadId(undefined);
        setDetail(undefined);
        return;
      }
      if (accountRes?.response.status === 204) {
        setLoadState("not_configured");
        setFolders([]);
        setThreads([]);
        setSelectedThreadId(undefined);
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
      setSelectedThreadId((current) =>
        current && nextThreads.some((thread) => thread.id === current)
          ? current
          : nextThreads[0]?.id,
      );
      setLoadState(nextThreads.length > 0 ? "ready" : "empty");
    } catch {
      setLoadState("error");
    }
  }, [api, folderId, query, unreadOnly]);

  useEffect(() => {
    void Promise.resolve().then(loadMailbox);
  }, [loadMailbox]);

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
      setCompose((prev) => ({ ...prev, [key]: value }));
      setEgressBlock(undefined);
    },
    [],
  );

  const resetCompose = useCallback(() => {
    setCompose(EMPTY_COMPOSE);
    setComposeAttachments([]);
    setEgressBlock(undefined);
  }, []);

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
      setSelectedThreadId(thread.id);
      if (thread.unread_count > 0) void setThreadSeen(thread.id, true);
    },
    [setThreadSeen],
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
    },
    [T.composer.validation.threadingUnavailable, T.thread.noSubject, selectedThread?.subject],
  );

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
    setSending(true);
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
      if (!response.data) {
        if (response.response.status === 503) setLoadState("unavailable");
        setError(compose.mode === "reply" ? T.composer.replyFailed : compose.mode === "forward" ? T.composer.forwardFailed : T.composer.failed);
        return;
      }
      setNotice(compose.mode === "reply" ? T.composer.replySent : compose.mode === "forward" ? T.composer.forwardSent : T.composer.sent);
      resetCompose();
    } catch {
      setError(compose.mode === "reply" ? T.composer.replyFailed : compose.mode === "forward" ? T.composer.forwardFailed : T.composer.failed);
    } finally {
      setSending(false);
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
    <div style={surfaceStyle}>
      <MailFolderPane folders={folders} selectedFolderId={folderId} onSelectFolder={setFolderId} />
      <MailThreadList
        threads={threads}
        selectedThreadId={selectedThreadId}
        queryDraft={queryDraft}
        unreadOnly={unreadOnly}
        loadState={loadState}
        onQueryDraftChange={setQueryDraft}
        onSubmitSearch={() => { setQuery(queryDraft); }}
        onUnreadOnlyChange={setUnreadOnly}
        onSelectThread={(thread) => { setSelectedThreadId(thread.id); }}
        onOpenThread={openThread}
      />
      <div style={{ display: "grid", minWidth: 0, alignContent: "start" }}>
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
          onIngestUnavailable={() => { setError(T.attachment.ingestUnavailable); }}
          onEvidenceUnavailable={() => { setError(T.attachment.evidenceUnavailable); }}
        />
        <div style={{ padding: "0 var(--sp-5) var(--sp-5)" }}>
          <MailComposer
            compose={compose}
            attachments={composeAttachments}
            sending={sending}
            egressBlock={egressBlock}
            onComposeChange={updateCompose}
            onClassificationChange={(classification: MailClassification) => { updateCompose("classification", classification); }}
            onFilesSelected={(files) => { setComposeAttachments((prev) => [...prev, ...files]); setEgressBlock(undefined); }}
            onRemoveAttachment={(file) => { setComposeAttachments((prev) => prev.filter((item) => item !== file)); setEgressBlock(undefined); }}
            onSubmit={() => { void sendCurrentMail(); }}
            onCancelThread={resetCompose}
            onAttachObjectUnavailable={() => { setError(T.composer.objectAttachUnavailable); }}
          />
        </div>
      </div>
    </div>
  );

  return (
    <PolicyGated action={MAIL_ACTIONS.read} resource={{ kind: "mail_screen" }}>
      <main className="console" style={rootStyle}>
        <header style={headerStyle}>
          <h1 style={titleStyle}>{T.title}</h1>
          <button type="button" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface)", color: "var(--ink)", padding: "0 var(--sp-4)", minHeight: "calc(var(--sp-6) * 2)", fontFamily: "var(--font-sans)", fontWeight: "var(--fw-strong)" }} onClick={() => { void loadMailbox(); }}>
            {T.state.refresh}
          </button>
        </header>
        {notice ? <div role="status" style={successStyle}>{notice}</div> : null}
        {error ? <div role="alert" style={alertStyle}>{error}</div> : null}
        {content}
      </main>
    </PolicyGated>
  );
}
