import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import { attachmentStateChips, MAIL_ACTIONS } from "./mailScreenConfig";
import { attachmentLabel } from "./format";
import { chipRowStyle, ghostButtonStyle, rowStyle, stackStyle, tightStackStyle } from "./styles";
import type { ConsoleMailAttachment } from "./types";

export function MailAttachmentRows({
  attachments,
  onDownload,
  onIngestUnavailable,
  onEvidenceUnavailable,
}: {
  attachments: ConsoleMailAttachment[];
  onDownload: (attachment: ConsoleMailAttachment) => void;
  onIngestUnavailable: (attachment: ConsoleMailAttachment) => void;
  onEvidenceUnavailable: (attachment: ConsoleMailAttachment) => void;
}) {
  if (attachments.length === 0) return null;
  const T = ko.console.mail.attachment;
  return (
    <div style={stackStyle} aria-label={T.listLabel}>
      {attachments.map((attachment) => {
        const chips = attachmentStateChips(attachment);
        return (
          <div
            key={attachment.id}
            style={{
              ...tightStackStyle,
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius)",
              padding: "var(--sp-3)",
              background: "var(--surface)",
            }}
          >
            <div style={rowStyle}>
              <span style={{ color: "var(--ink)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-strong)" }}>
                {attachmentLabel(attachment)}
              </span>
              {attachment.is_inline ? <StatusChip tone="neutral">{T.inline}</StatusChip> : null}
            </div>
            {chips.length > 0 ? (
              <div style={chipRowStyle}>
                {chips.map((chip) => (
                  <StatusChip key={chip.key} tone={chip.tone} role={chip.role}>
                    {chip.label}
                  </StatusChip>
                ))}
              </div>
            ) : null}
            <div style={chipRowStyle}>
              <PolicyGated action={MAIL_ACTIONS.attachmentIngest} resource={{ kind: "mail_attachment", id: attachment.id }}>
                <button
                  type="button"
                  style={ghostButtonStyle}
                  aria-label={T.actionLabel(attachment.filename, T.ingest)}
                  onClick={() => { onIngestUnavailable(attachment); }}
                >
                  {T.ingest}
                </button>
              </PolicyGated>
              <PolicyGated action={MAIL_ACTIONS.evidenceRegister} resource={{ kind: "mail_attachment", id: attachment.id }}>
                <button
                  type="button"
                  style={ghostButtonStyle}
                  aria-label={T.actionLabel(attachment.filename, T.evidenceRegister)}
                  onClick={() => { onEvidenceUnavailable(attachment); }}
                >
                  {T.evidenceRegister}
                </button>
              </PolicyGated>
              <PolicyGated action={MAIL_ACTIONS.attachmentDownload} resource={{ kind: "mail_attachment", id: attachment.id }}>
                <button
                  type="button"
                  style={ghostButtonStyle}
                  aria-label={T.actionLabel(attachment.filename, T.download)}
                  onClick={() => { onDownload(attachment); }}
                >
                  {T.download}
                </button>
              </PolicyGated>
            </div>
          </div>
        );
      })}
    </div>
  );
}
