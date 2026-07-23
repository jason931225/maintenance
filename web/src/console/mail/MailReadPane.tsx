import { useMemo, useState } from "react";

import { ko } from "../../i18n/ko";
import { PolicyGated } from "../policy";
import { names, formatMailDate, splitObjectCodes, textBody } from "./format";
import { safeConsoleMailHref, sanitizeConsoleMailHtml } from "./html";
import { MAIL_ACTIONS, messageGovernance } from "./mailScreenConfig";
import { MailAttachmentRows } from "./MailAttachmentRows";
import { GovernanceChipRow, SenderAuthPanel } from "./MailGovernance";
import {
  chipRowStyle,
  ghostButtonStyle,
  mutedTextStyle,
  paneStyle,
  rowStyle,
  sectionTitleStyle,
  stackStyle,
  statusRowStyle,
  tightStackStyle,
} from "./styles";
import type { ConsoleMailAttachment, ConsoleMailMessage, ConsoleMailThread, ConsoleMailThreadDetail } from "./types";

function messageBodyParts(message: ConsoleMailMessage) {
  const refs = new Map((message.governance?.object_refs ?? []).map((ref) => [ref.code, ref.href]));
  return splitObjectCodes(textBody(message)).map((part, index) => {
    if (!part.code) return <span key={String(index)}>{part.text}</span>;
    const href = refs.get(part.code);
    const safeHref = href ? safeConsoleMailHref(href) : undefined;
    if (!safeHref) return <span key={String(index)}>{part.text}</span>;
    const opensNewContext = /^(https?:|mailto:|tel:)/i.test(safeHref);
    return (
      <a
        key={`${part.code}-${String(index)}`}
        href={safeHref}
        target={opensNewContext ? "_blank" : undefined}
        rel={opensNewContext ? "noopener noreferrer" : undefined}
        style={{ color: "var(--purple-tx)", fontWeight: "var(--fw-strong)" }}
      >
        {part.text}
      </a>
    );
  });
}

function MailMessageBody({ message }: { message: ConsoleMailMessage }) {
  const sanitizedHtml = useMemo(
    () => (message.body_html ? sanitizeConsoleMailHtml(message.body_html) : ""),
    [message.body_html],
  );
  if (sanitizedHtml.trim().length > 0) {
    return (
      <div
        data-testid="mail-html-body"
        style={{
          color: "var(--ink)",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--fw-body)",
          lineHeight: "var(--lh-base)",
          overflowWrap: "anywhere",
        }}
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }
  return (
    <p data-testid="mail-text-body" style={{ ...mutedTextStyle, whiteSpace: "pre-wrap", color: "var(--ink)" }}>
      {messageBodyParts(message)}
    </p>
  );
}

function CollapsedMessageRow({ message, index, onExpand }: { message: ConsoleMailMessage; index: number; onExpand: () => void }) {
  const T = ko.console.mail.read;
  return (
    <button
      type="button"
      style={{
        ...ghostButtonStyle,
        display: "grid",
        width: "100%",
        height: "auto",
        justifyItems: "start",
        textAlign: "left",
      }}
      onClick={onExpand}
    >
      <span style={{ color: "var(--ink)", fontWeight: "var(--fw-strong)" }}>
        {String(index + 1)} · {message.from_name || message.from_address}
      </span>
      <span style={{ color: "var(--steel)", fontWeight: "var(--fw-body)" }}>
        {formatMailDate(message.received_at)} · {message.snippet || T.emptyBody}
      </span>
      <span style={{ color: "var(--info-tx)" }}>{T.expandMessage}</span>
    </button>
  );
}

function MessageArticle({
  message,
  onReply,
  onForward,
  onDownloadAttachment,
}: {
  message: ConsoleMailMessage;
  onReply: (message: ConsoleMailMessage) => void;
  onForward: (message: ConsoleMailMessage) => void;
  onDownloadAttachment: (attachment: ConsoleMailAttachment) => void;
}) {
  const T = ko.console.mail.read;
  const governance = messageGovernance(message);
  return (
    <article style={{ ...stackStyle, border: "1px solid var(--border-soft)", borderRadius: "var(--radius)", padding: "var(--sp-4)" }}>
      <header style={tightStackStyle}>
        <div style={rowStyle}>
          <div style={tightStackStyle}>
            <strong style={{ color: "var(--ink)", fontSize: "var(--text-card-title)" }}>
              {message.from_name || message.from_address}
            </strong>
            <span style={{ color: "var(--steel)", fontSize: "var(--text-xs)" }}>
              {T.to}: {names(message.to)}
            </span>
          </div>
          <time style={{ color: "var(--steel)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
            {formatMailDate(message.received_at)}
          </time>
        </div>
        <SenderAuthPanel auth={message.sender_auth ?? governance?.sender_auth} />
        <GovernanceChipRow governance={governance} />
        <div style={chipRowStyle} aria-label={T.actions}>
          <PolicyGated action={MAIL_ACTIONS.reply} resource={{ kind: "mail_message", id: message.id }}>
            <button type="button" style={ghostButtonStyle} onClick={() => { onReply(message); }}>
              {T.reply}
            </button>
          </PolicyGated>
          <PolicyGated action={MAIL_ACTIONS.forward} resource={{ kind: "mail_message", id: message.id }}>
            <button type="button" style={ghostButtonStyle} onClick={() => { onForward(message); }}>
              {T.forward}
            </button>
          </PolicyGated>
        </div>
      </header>
      <MailMessageBody message={message} />
      <MailAttachmentRows
        attachments={message.attachments}
        onDownload={onDownloadAttachment}
      />
    </article>
  );
}

export function MailReadPane({
  selectedThread,
  detail,
  detailLoading,
  onMarkSeen,
  onReply,
  onForward,
  onDownloadAttachment,
}: {
  selectedThread?: ConsoleMailThread;
  detail?: ConsoleMailThreadDetail;
  detailLoading: boolean;
  onMarkSeen: (seen: boolean) => void;
  onReply: (message: ConsoleMailMessage) => void;
  onForward: (message: ConsoleMailMessage) => void;
  onDownloadAttachment: (attachment: ConsoleMailAttachment) => void;
}) {
  const T = ko.console.mail;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const subject = selectedThread?.subject || detail?.subject || T.thread.noSubject;
  const messages = detail?.messages ?? [];
  const latest = messages[messages.length - 1];
  const prior = messages.slice(0, -1);
  return (
    <section className="mail-screen__reader" aria-label={T.read.regionLabel} style={paneStyle}>
      <header style={stackStyle}>
        <div style={rowStyle}>
          <div style={tightStackStyle}>
            <h2 style={sectionTitleStyle}>{selectedThread ? subject : T.read.regionLabel}</h2>
            {selectedThread ? <p style={mutedTextStyle}>{T.thread.messageCount(selectedThread.message_count)}</p> : null}
          </div>
          {selectedThread ? (
            <PolicyGated action={MAIL_ACTIONS.markRead} resource={{ kind: "mail_thread", id: selectedThread.id }}>
              <button type="button" style={ghostButtonStyle} onClick={() => { onMarkSeen(selectedThread.unread_count > 0); }}>
                {selectedThread.unread_count > 0 ? T.read.markRead : T.read.markUnread}
              </button>
            </PolicyGated>
          ) : null}
        </div>
        <GovernanceChipRow governance={detail?.governance ?? selectedThread?.governance} />
      </header>
      {!selectedThread ? (
        <div role="status" style={statusRowStyle}>{T.read.selectThread}</div>
      ) : detailLoading ? (
        <div role="status" style={statusRowStyle}>{T.state.loading}</div>
      ) : !detail ? (
        <div role="alert" style={statusRowStyle}>{T.read.loadFailed}</div>
      ) : messages.length === 0 ? (
        <div role="status" style={statusRowStyle}>{T.read.emptyBody}</div>
      ) : (
        <div style={stackStyle}>
          {prior.length > 0 ? (
            <div style={stackStyle}>
              <span style={{ color: "var(--steel)", fontSize: "var(--text-xs)", fontWeight: "var(--fw-strong)" }}>
                {T.read.collapsedMessages(prior.length)}
              </span>
              {prior.map((message, index) => expandedIds.has(message.id) ? (
                <MessageArticle
                  key={message.id}
                  message={message}
                  onReply={onReply}
                  onForward={onForward}
                  onDownloadAttachment={onDownloadAttachment}
                />
              ) : (
                <CollapsedMessageRow
                  key={message.id}
                  message={message}
                  index={index}
                  onExpand={() => { setExpandedIds((prev) => new Set(prev).add(message.id)); }}
                />
              ))}
            </div>
          ) : null}
          <MessageArticle
            message={latest}
            onReply={onReply}
            onForward={onForward}
            onDownloadAttachment={onDownloadAttachment}
          />
        </div>
      )}
    </section>
  );
}
