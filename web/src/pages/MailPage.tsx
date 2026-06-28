import {
  ExternalLink,
  Inbox,
  Mail,
  Paperclip,
  Phone,
  RefreshCw,
  Search,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type {
  CustomerInquiryView,
  InquiryStatus,
  MailAttachmentView,
  MailFolderView,
  MailMessageView,
  MailThreadDetail,
  MailThreadView,
  SendMailRequest,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatKoreanDateTime } from "../lib/datetime";
import { sanitizeMailHtml } from "../lib/mailHtml";
import { cn } from "../lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type LoadState = "loading" | "ready" | "empty" | "error" | "unavailable" | "not_configured";
type InquiryLoadState = "idle" | "loading" | "ready" | "error";

interface ComposeForm {
  mode: "new" | "reply" | "forward";
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references: string[];
}

const EMPTY_COMPOSE: ComposeForm = {
  mode: "new",
  to: "",
  subject: "",
  body: "",
  references: [],
};

const INQUIRY_BADGE: Record<InquiryStatus, string> = {
  NEW: "border-brand-teal bg-brand-teal/10 text-brand-teal",
  CONTACTED: "border-signal-dark bg-signal/15 text-signal-dark",
  CLOSED: "border-line text-steel",
};

function names(addresses: MailMessageView["to"]): string {
  return addresses.map((a) => a.name || a.address).join(", ");
}

function parseRecipients(value: string): SendMailRequest["to"] {
  return value
    .split(/[;,\s]+/)
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
}

function uniqueReferences(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
  );
}

function replyRecipients(message: MailMessageView): string {
  if (message.direction === "OUT" && message.to.length > 0) {
    return message.to.map((address) => address.address).join(", ");
  }
  return message.from_address;
}

function replySubject(subject: string): string {
  const cleanSubject = subject.trim();
  if (/^re:/i.test(cleanSubject)) return cleanSubject;
  return `Re: ${cleanSubject}`;
}

function forwardSubject(subject: string): string {
  const cleanSubject = subject.trim();
  if (/^(fwd|fw):/i.test(cleanSubject)) return cleanSubject;
  return `Fwd: ${cleanSubject}`;
}

function buildThreadReferences(message: MailMessageView): string[] {
  return uniqueReferences([message.in_reply_to, message.message_id]);
}

function originalMessageBlock(message: MailMessageView, c: typeof ko.mailbox): string {
  const from = message.from_name
    ? `${message.from_name} <${message.from_address}>`
    : message.from_address;
  return [
    "",
    "",
    c.originalMessage,
    `${c.originalFrom}: ${from}`,
    `${c.originalAt}: ${formatKoreanDateTime(message.received_at)}`,
    `${c.originalSubject}: ${message.subject || c.noSubject}`,
    "",
    textBody(message),
  ].join("\n");
}

function folderLabel(folder: MailFolderView): string {
  const labels: Partial<Record<string, string>> = ko.mailbox.folderRoles;
  return labels[folder.role.toLowerCase()] ?? folder.name;
}

function textBody(message: MailMessageView): string {
  return message.body_text || message.snippet || ko.mailbox.emptyBody;
}

function fileAttachmentLabel(file: File): string {
  return `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
}

function attachmentLabel(attachment: MailAttachmentView): string {
  const size = attachment.size_bytes > 0
    ? ` · ${(attachment.size_bytes / 1024).toFixed(1)} KB`
    : "";
  return `${attachment.filename}${size}`;
}

function totalAttachmentBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function fileToMailAttachment(
  file: File,
): Promise<NonNullable<SendMailRequest["attachments"]>[number]> {
  return {
    filename: file.name,
    content_type: file.type || "application/octet-stream",
    content_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

function safeAttachmentDownloadUrl(raw: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const url = new URL(raw, window.location.origin);
    const isHttps = url.protocol === "https:";
    const isLocalHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        (url.origin === window.location.origin && window.location.protocol === "http:"));
    return isHttps || isLocalHttp ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function MailMessageBody({ message }: { message: MailMessageView }) {
  const sanitizedHtml = useMemo(
    () => (message.body_html ? sanitizeMailHtml(message.body_html) : ""),
    [message.body_html],
  );
  if (sanitizedHtml.trim().length > 0) {
    return (
      <div
        data-testid="mail-html-body"
        className="mt-3 max-w-none break-words text-sm leading-6 text-ink [&_a]:font-semibold [&_a]:text-brand-teal [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:p-1 [&_th]:border [&_th]:border-line [&_th]:bg-muted-panel [&_th]:p-1 [&_ul]:list-disc [&_ul]:pl-5"
        // Sanitized at the render boundary by DOMPurify. Do not replace with a
        // custom sanitizer; raw body_html is untrusted mailbox input.
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }
  return (
    <p data-testid="mail-text-body" className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink">
      {textBody(message)}
    </p>
  );
}

export function MailPage() {
  const { api, session } = useAuth();
  const c = ko.mailbox;
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [folders, setFolders] = useState<MailFolderView[]>([]);
  const [threads, setThreads] = useState<MailThreadView[]>([]);
  const [folderId, setFolderId] = useState<string>();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [detail, setDetail] = useState<MailThreadDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [compose, setCompose] = useState<ComposeForm>(EMPTY_COMPOSE);
  const [composeAttachments, setComposeAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [inquiries, setInquiries] = useState<CustomerInquiryView[]>([]);
  const [inquiryLoadState, setInquiryLoadState] = useState<InquiryLoadState>("idle");
  const [inquiryBusyId, setInquiryBusyId] = useState<string>();

  const canUseAdminSettings =
    session?.roles?.some((role) => role === "ADMIN" || role === "SUPER_ADMIN") ?? false;
  const canManageInquiries = canUseAdminSettings;

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId),
    [selectedThreadId, threads],
  );

  const unreadCount = useMemo(
    () => threads.reduce((sum, thread) => sum + thread.unread_count, 0),
    [threads],
  );

  const loadMailbox = useCallback(async () => {
    setLoadState("loading");
    setError(undefined);
    const queryParams: {
      folder?: string;
      unread?: boolean;
      q?: string;
      limit: number;
    } = { limit: 50 };
    if (folderId) queryParams.folder = folderId;
    if (unreadOnly) queryParams.unread = true;
    if (query.trim()) queryParams.q = query.trim();

    try {
      const accountRequest = canUseAdminSettings
        ? api.GET("/api/v1/mail/account").catch(() => undefined)
        : Promise.resolve(undefined);
      const [accountRes, folderRes, threadRes] = await Promise.all([
        accountRequest,
        api.GET("/api/v1/mail/folders"),
        api.GET("/api/v1/mail/threads", {
          params: { query: queryParams },
        }),
      ]);
      if (
        accountRes?.response.status === 503 ||
        folderRes.response.status === 503 ||
        threadRes.response.status === 503
      ) {
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
      setFolders(folderRes.data);
      setThreads(threadRes.data);
      setSelectedThreadId((current) =>
        current && threadRes.data.some((thread) => thread.id === current)
          ? current
          : threadRes.data[0]?.id,
      );
      setLoadState(threadRes.data.length > 0 ? "ready" : "empty");
    } catch {
      setLoadState("error");
    }
  }, [api, canUseAdminSettings, folderId, query, unreadOnly]);

  const loadInquiries = useCallback(async () => {
    if (!canManageInquiries) {
      setInquiries([]);
      setInquiryLoadState("idle");
      return;
    }
    setInquiryLoadState("loading");
    const { data, response } = await api
      .GET("/api/v1/sales/inquiries", {
        params: { query: { status: "NEW", limit: 5, offset: 0 } },
      })
      .catch(() => ({ data: undefined, response: undefined }) as const);
    if (!data) {
      if (response?.status === 403) {
        setInquiries([]);
        setInquiryLoadState("idle");
        return;
      }
      setInquiryLoadState("error");
      return;
    }
    setInquiries(data.items);
    setInquiryLoadState("ready");
  }, [api, canManageInquiries]);

  useEffect(() => {
    void Promise.resolve().then(loadMailbox);
  }, [loadMailbox]);

  useEffect(() => {
    if (!canManageInquiries) return;
    void Promise.resolve().then(loadInquiries);
  }, [canManageInquiries, loadInquiries]);

  useEffect(() => {
    let ignore = false;
    void Promise.resolve().then(async () => {
      if (!selectedThreadId) {
        if (!ignore) setDetail(undefined);
        return;
      }
      if (!ignore) setDetailLoading(true);
      try {
        const res = await api.GET("/api/v1/mail/threads/{id}", {
          params: { path: { id: selectedThreadId } },
        });
        if (!ignore) setDetail(res.data);
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
    <K extends keyof ComposeForm>(key: K, value: ComposeForm[K]) => {
      setCompose((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const resetCompose = useCallback(() => {
    setCompose(EMPTY_COMPOSE);
    setComposeAttachments([]);
  }, []);

  const startThreadedCompose = useCallback(
    (mode: "reply" | "forward", message: MailMessageView) => {
      const parentMessageId = message.message_id?.trim();
      if (!parentMessageId) {
        setError(c.threadingUnavailable);
        return;
      }
      setNotice(undefined);
      setError(undefined);
      setCompose({
        mode,
        to: mode === "reply" ? replyRecipients(message) : "",
        subject: mode === "reply"
          ? replySubject(message.subject || selectedThread?.subject || c.noSubject)
          : forwardSubject(message.subject || selectedThread?.subject || c.noSubject),
        body: mode === "forward" ? originalMessageBlock(message, c) : "",
        inReplyTo: parentMessageId,
        references: buildThreadReferences(message),
      });
      setComposeAttachments([]);
    },
    [c, selectedThread?.subject],
  );

  const sendMail = useCallback(async () => {
    setNotice(undefined);
    setError(undefined);
    const mode = compose.mode;
    const recipients = parseRecipients(compose.to);
    if (recipients.length === 0 || recipients.some((r) => !EMAIL_RE.test(r.address))) {
      setError(c.validation.to);
      return;
    }
    if (!compose.subject.trim()) {
      setError(c.validation.subject);
      return;
    }
    if (!compose.body.trim()) {
      setError(c.validation.body);
      return;
    }
    if (mode !== "new" && !compose.inReplyTo) {
      setError(c.threadingUnavailable);
      return;
    }
    if (totalAttachmentBytes(composeAttachments) > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      setError(c.validation.attachments);
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
      if (attachments) {
        requestBody.attachments = attachments;
      }
      if (mode !== "new") {
        requestBody.in_reply_to = compose.inReplyTo;
        requestBody.references = compose.references;
      }
      const res = mode === "reply"
        ? await api.POST("/api/v1/mail/reply", { body: requestBody })
        : mode === "forward"
          ? await api.POST("/api/v1/mail/forward", { body: requestBody })
          : await api.POST("/api/v1/mail/send", { body: requestBody });
      if (!res.data) {
        if (res.response.status === 503) {
          setLoadState("unavailable");
          return;
        }
        setError(mode === "reply" ? c.replyFailed : mode === "forward" ? c.forwardFailed : c.sendFailed);
        return;
      }
      resetCompose();
      setNotice(mode === "reply" ? c.replySent : mode === "forward" ? c.forwardSent : c.sent);
      await loadMailbox();
    } catch {
      setError(mode === "reply" ? c.replyFailed : mode === "forward" ? c.forwardFailed : c.sendFailed);
    } finally {
      setSending(false);
    }
  }, [api, c, compose, composeAttachments, loadMailbox, resetCompose]);

  const submitSearch = useCallback(() => {
    setQuery(queryDraft);
  }, [queryDraft]);

  const markInquiryContacted = useCallback(
    async (inquiry: CustomerInquiryView) => {
      setError(undefined);
      setInquiryBusyId(inquiry.id);
      try {
        const { error: apiError } = await api.PATCH("/api/v1/sales/inquiries/{id}", {
          params: { path: { id: inquiry.id } },
          body: { status: "CONTACTED" },
        });
        if (apiError) throw new Error("inquiry status update failed");
        setNotice(ko.mailbox.inquiryMarkedContacted);
        await loadInquiries();
      } catch {
        setError(ko.mailbox.inquiryUpdateFailed);
      } finally {
        setInquiryBusyId(undefined);
      }
    },
    [api, loadInquiries],
  );

  const openAttachment = useCallback(
    async (attachment: MailAttachmentView) => {
      setError(undefined);
      const { data } = await api
        .GET("/api/v1/mail/attachments/{id}/download", {
          params: { path: { id: attachment.id } },
        })
        .catch(() => ({ data: undefined }) as const);
      if (!data?.url) {
        setError(c.attachmentDownloadFailed);
        return;
      }
      const safeUrl = safeAttachmentDownloadUrl(data.url);
      if (!safeUrl) {
        setError(c.attachmentDownloadFailed);
        return;
      }
      window.open(safeUrl, "_blank", "noopener,noreferrer");
    },
    [api, c.attachmentDownloadFailed],
  );

  return (
    <div>
      <PageHeader
        title={c.title}
        description={c.description}
        actions={
          <Button type="button" variant="secondary" onClick={() => { void loadMailbox(); }}>
            <RefreshCw size={16} aria-hidden="true" />
            {ko.page.refresh}
          </Button>
        }
      />

      <div className="mb-4 grid gap-2">
        <FeedbackBanner message={notice} kind="success" onDismiss={() => { setNotice(undefined); }} />
        <FeedbackBanner message={error} kind="error" onDismiss={() => { setError(undefined); }} />
      </div>

      {loadState === "loading" ? (
        <SkeletonCards count={3} lines={3} />
      ) : loadState === "error" ? (
        <PageError message={c.loadFailed} onRetry={() => { void loadMailbox(); }} />
      ) : loadState === "not_configured" ? (
        <Card className="max-w-3xl">
          <div className="flex items-start gap-3">
            <span className="rounded-full bg-muted-panel p-2 text-steel">
              <Inbox size={20} aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-ink">{c.notConfiguredTitle}</h2>
              <p className="mt-1 text-sm text-steel">{c.notConfiguredBody}</p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-steel">
                {c.notConfiguredSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <Button asChild type="button" variant="secondary" className="mt-4">
                <Link to="/settings/email">{c.configureServer}</Link>
              </Button>
            </div>
          </div>
        </Card>
      ) : loadState === "unavailable" ? (
        <Card className="max-w-3xl">
          <div className="flex items-start gap-3">
            <span className="rounded-full bg-muted-panel p-2 text-steel">
              <Inbox size={20} aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-ink">{c.unavailableTitle}</h2>
              <p className="mt-1 text-sm text-steel">{c.unavailableBody}</p>
              {canUseAdminSettings ? (
                <Button asChild type="button" variant="secondary" className="mt-4">
                  <Link to="/settings/email">{c.configureServer}</Link>
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[18rem_minmax(20rem,1fr)_minmax(20rem,28rem)]">
          <Card className="space-y-4">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <Mail size={18} aria-hidden="true" />
                {c.folders}
              </h2>
              <p className="mt-1 text-sm text-steel">{c.unreadSummary(unreadCount)}</p>
            </div>
            <div className="grid gap-2" aria-label={c.folderList}>
              <Button
                type="button"
                variant={!folderId ? "default" : "secondary"}
                className="justify-between"
                onClick={() => { setFolderId(undefined); }}
              >
                <span>{c.allFolders}</span>
              </Button>
              {folders.map((folder) => (
                <Button
                  key={folder.id}
                  type="button"
                  variant={folder.id === folderId ? "default" : "secondary"}
                  className="justify-between"
                  onClick={() => { setFolderId(folder.id); }}
                >
                  <span>{folderLabel(folder)}</span>
                  <span className="text-xs font-semibold">
                    {folder.unread_count}/{folder.total_count}
                  </span>
                </Button>
              ))}
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-ink">{c.threads}</h2>
              <label className="inline-flex items-center gap-2 text-sm font-medium text-steel">
                <input
                  type="checkbox"
                  className="size-4 rounded border-line text-ink"
                  checked={unreadOnly}
                  onChange={(event) => { setUnreadOnly(event.target.checked); }}
                />
                {c.unreadOnly}
              </label>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submitSearch();
              }}
            >
              <Input
                type="search"
                aria-label={c.search}
                placeholder={c.searchPlaceholder}
                value={queryDraft}
                onChange={(event) => { setQueryDraft(event.target.value); }}
              />
              <Button type="submit" variant="secondary" aria-label={c.search}>
                <Search size={16} aria-hidden="true" />
              </Button>
            </form>

            {loadState === "empty" ? (
              <div role="status" className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-steel">
                {c.emptyThreads}
              </div>
            ) : (
              <div className="grid gap-2" role="list" aria-label={c.threadList}>
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    role="listitem"
                    onClick={() => { setSelectedThreadId(thread.id); }}
                    className={cn(
                      "rounded-lg border border-line p-3 text-left transition hover:bg-muted-panel/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                      thread.id === selectedThreadId && "border-ink bg-muted-panel/60",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-ink">{thread.subject || c.noSubject}</span>
                      <span className="shrink-0 text-xs text-steel">{formatKoreanDateTime(thread.last_message_at)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-steel">
                      <Badge>{c.messageCount(thread.message_count)}</Badge>
                      {thread.unread_count > 0 ? <Badge>{c.unreadCount(thread.unread_count)}</Badge> : null}
                      {thread.has_attachments ? (
                        <span className="inline-flex items-center gap-1">
                          <Paperclip size={12} aria-hidden="true" />
                          {c.attachment}
                        </span>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <div className="grid gap-4">
            <Card className="min-h-80 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-ink">
                  {selectedThread?.subject || c.selectedThreadTitle}
                </h2>
                {selectedThread ? (
                  <p className="mt-1 text-sm text-steel">
                    {c.messageCount(selectedThread.message_count)}
                  </p>
                ) : null}
              </div>
              {!selectedThreadId ? (
                <div role="status" className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-steel">
                  {c.selectThread}
                </div>
              ) : detailLoading ? (
                <SkeletonCards count={2} lines={2} />
              ) : detail ? (
                <div className="grid gap-3">
                  {detail.messages.map((message) => (
                    <article key={message.id} className="rounded-lg border border-line p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-ink">
                            {message.from_name || message.from_address}
                          </p>
                          <p className="text-xs text-steel">{names(message.to)}</p>
                        </div>
                        <span className="text-xs text-steel">{formatKoreanDateTime(message.received_at)}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2" aria-label={c.messageActions}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={!message.message_id}
                          title={!message.message_id ? c.threadingUnavailable : undefined}
                          onClick={() => { startThreadedCompose("reply", message); }}
                        >
                          {c.reply}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={!message.message_id}
                          title={!message.message_id ? c.threadingUnavailable : undefined}
                          onClick={() => { startThreadedCompose("forward", message); }}
                        >
                          {c.forward}
                        </Button>
                      </div>
                      <MailMessageBody message={message} />
                      {message.attachments.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {message.attachments.map((attachment) => (
                            <Button
                              key={attachment.id}
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => { void openAttachment(attachment); }}
                            >
                              <Paperclip size={14} aria-hidden="true" />
                              {attachmentLabel(attachment)}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <PageError message={c.threadLoadFailed} />
              )}
            </Card>

            {canManageInquiries ? (
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-ink">
                      {c.inquiryQueue}
                    </h2>
                    <p className="mt-1 text-sm text-steel">
                      {c.inquiryQueueDescription}
                    </p>
                  </div>
                  <Button asChild type="button" variant="secondary" size="sm">
                    <Link to="/catalog">
                      <ExternalLink size={14} aria-hidden="true" />
                      {c.openInquiries}
                    </Link>
                  </Button>
                </div>
                {inquiryLoadState === "loading" ? (
                  <SkeletonCards count={1} lines={2} />
                ) : inquiryLoadState === "error" ? (
                  <PageError message={c.inquiryLoadFailed} onRetry={() => { void loadInquiries(); }} />
                ) : inquiries.length === 0 ? (
                  <div role="status" className="rounded-lg border border-dashed border-line p-4 text-sm text-steel">
                    {c.noNewInquiries}
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {inquiries.map((inquiry) => (
                      <article key={inquiry.id} className="rounded-lg border border-line p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-ink">{inquiry.name}</p>
                            <p className="text-xs text-steel">
                              {ko.catalog.inquiries.topicLabels[inquiry.topic]}
                              {inquiry.location ? ` · ${inquiry.location}` : ""}
                            </p>
                          </div>
                          <Badge className={INQUIRY_BADGE[inquiry.status]}>
                            {ko.catalog.inquiries.statusLabels[inquiry.status]}
                          </Badge>
                        </div>
                        {inquiry.message ? (
                          <p className="mt-2 line-clamp-2 whitespace-pre-line text-sm text-steel">
                            {inquiry.message}
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button asChild type="button" variant="secondary" size="sm">
                            <a href={`tel:${inquiry.phone.replace(/[^0-9+]/g, "")}`}>
                              <Phone size={14} aria-hidden="true" />
                              {inquiry.phone}
                            </a>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={inquiryBusyId === inquiry.id}
                            onClick={() => { void markInquiryContacted(inquiry); }}
                          >
                            {c.markInquiryContacted}
                          </Button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </Card>
            ) : null}

            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-ink">
                    {compose.mode === "reply"
                      ? c.replyCompose
                      : compose.mode === "forward"
                        ? c.forwardCompose
                        : c.compose}
                  </h2>
                  {compose.mode !== "new" ? (
                    <p className="mt-1 text-sm text-steel">{c.threadedComposeHint}</p>
                  ) : null}
                </div>
                {compose.mode !== "new" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { resetCompose(); }}
                  >
                    {c.cancelThreadedCompose}
                  </Button>
                ) : null}
              </div>
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1 text-sm font-medium text-steel">
                  {c.to}
                  <Input
                    type="text"
                    inputMode="email"
                    placeholder={c.toPlaceholder}
                    value={compose.to}
                    onChange={(event) => { updateCompose("to", event.target.value); }}
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium text-steel">
                  {c.subject}
                  <Input
                    type="text"
                    placeholder={c.subjectPlaceholder}
                    value={compose.subject}
                    onChange={(event) => { updateCompose("subject", event.target.value); }}
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium text-steel">
                  {c.body}
                  <Textarea
                    rows={5}
                    placeholder={c.bodyPlaceholder}
                    value={compose.body}
                    onChange={(event) => { updateCompose("body", event.target.value); }}
                  />
                </label>
                <div className="grid gap-2">
                  <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-medium text-steel transition hover:border-brand-teal">
                    <Paperclip size={16} aria-hidden="true" />
                    {c.attachFiles}
                    <input
                      className="sr-only"
                      type="file"
                      multiple
                      onChange={(event) => {
                        const selectedFiles = Array.from(event.currentTarget.files ?? []);
                        setComposeAttachments((prev) => [...prev, ...selectedFiles]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <p className="text-xs text-steel">{c.attachmentLimit}</p>
                  {composeAttachments.length > 0 ? (
                    <ul className="grid gap-1" aria-label={c.selectedAttachments}>
                      {composeAttachments.map((file, index) => (
                        <li
                          key={`${file.name}-${String(file.size)}-${String(file.lastModified)}-${String(index)}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm text-steel"
                        >
                          <span>{fileAttachmentLabel(file)}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`${file.name} ${c.removeAttachment}`}
                            onClick={() => {
                              setComposeAttachments((prev) => prev.filter((item) => item !== file));
                            }}
                          >
                            {c.removeAttachment}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <Button type="button" onClick={() => { void sendMail(); }} disabled={sending}>
                  <Send size={16} aria-hidden="true" />
                  {sending
                    ? c.sending
                    : compose.mode === "reply"
                      ? c.replySend
                      : compose.mode === "forward"
                        ? c.forwardSend
                        : c.send}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
