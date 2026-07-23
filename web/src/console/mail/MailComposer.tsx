import type { KeyboardEvent } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import { fileAttachmentLabel } from "./format";
import { EgressGatePanel } from "./MailGovernance";
import { CLASSIFICATION_OPTIONS, MAIL_ACTIONS } from "./mailScreenConfig";
import {
  chipRowStyle,
  ghostButtonStyle,
  hiddenFileInputStyle,
  inputStyle,
  labelStyle,
  primaryButtonStyle,
  rowStyle,
  sectionTitleStyle,
  stackStyle,
  textAreaStyle,
  tightStackStyle,
} from "./styles";
import type { MailClassification, MailComposerState, MailEgressBlock } from "./types";

export function MailComposer({
  compose,
  attachments,
  sending,
  egressBlock,
  onComposeChange,
  onClassificationChange,
  onFilesSelected,
  onRemoveAttachment,
  onSubmit,
  onCancelThread,
}: {
  compose: MailComposerState;
  attachments: File[];
  sending: boolean;
  egressBlock?: MailEgressBlock;
  onComposeChange: <K extends keyof MailComposerState>(key: K, value: MailComposerState[K]) => void;
  onClassificationChange: (classification: MailClassification) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (file: File) => void;
  onSubmit: () => void;
  onCancelThread: () => void;
}) {
  const T = ko.console.mail.composer;
  const title = compose.mode === "reply"
    ? T.replyTitle
    : compose.mode === "forward"
      ? T.forwardTitle
      : T.newTitle;
  const sendLabel = sending
    ? T.sending
    : compose.mode === "reply"
      ? T.replySend
      : compose.mode === "forward"
        ? T.forwardSend
        : T.send;

  function handleBodyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      sending ||
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      (!event.metaKey && !event.ctrlKey)
    ) {
      return;
    }
    event.preventDefault();
    onSubmit();
  }

  return (
    <form
      aria-label={T.formLabel}
      style={{ ...stackStyle, borderTop: "1px solid var(--border-soft)", paddingTop: "var(--sp-5)" }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div style={rowStyle}>
        <h2 style={sectionTitleStyle}>{title}</h2>
        <button type="button" style={ghostButtonStyle} onClick={onCancelThread}>
          {T.close}
        </button>
      </div>
      <div style={chipRowStyle}>
        {CLASSIFICATION_OPTIONS.map((option) => {
          const selected = compose.classification === option.value;
          return (
            <PolicyGated key={option.value} action={MAIL_ACTIONS.send} resource={{ kind: "mail_classification" }}>
              <button
                type="button"
                aria-pressed={selected}
                style={{
                  ...ghostButtonStyle,
                  borderColor: selected ? "var(--ink)" : "var(--border)",
                  background: selected ? "var(--muted)" : "var(--surface)",
                }}
                onClick={() => { onClassificationChange(option.value); }}
              >
                {option.label}
              </button>
            </PolicyGated>
          );
        })}
      </div>
      <label style={labelStyle}>
        {T.to}
        <input
          type="text"
          inputMode="email"
          autoComplete="email"
          placeholder={T.toPlaceholder}
          value={compose.to}
          style={inputStyle}
          onChange={(event) => { onComposeChange("to", event.currentTarget.value); }}
        />
      </label>
      <div className="mail-screen__recipient-columns" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "var(--sp-3)" }}>
        <label style={labelStyle}>
          {T.cc}
          <input
            type="text"
            inputMode="email"
            value={compose.cc}
            style={inputStyle}
            onChange={(event) => { onComposeChange("cc", event.currentTarget.value); }}
          />
        </label>
        <label style={labelStyle}>
          {T.bcc}
          <input
            type="text"
            inputMode="email"
            value={compose.bcc}
            style={inputStyle}
            onChange={(event) => { onComposeChange("bcc", event.currentTarget.value); }}
          />
        </label>
      </div>
      <label style={labelStyle}>
        {T.subject}
        <input
          type="text"
          placeholder={T.subjectPlaceholder}
          value={compose.subject}
          style={inputStyle}
          onChange={(event) => { onComposeChange("subject", event.currentTarget.value); }}
        />
      </label>
      <label style={labelStyle}>
        {T.body}
        <textarea
          aria-label={T.body}
          rows={5}
          placeholder={T.bodyPlaceholder}
          value={compose.body}
          style={textAreaStyle}
          onChange={(event) => { onComposeChange("body", event.currentTarget.value); }}
          onKeyDown={handleBodyKeyDown}
        />
        <span style={{ color: "var(--steel)", fontSize: "var(--text-xs)", fontWeight: "var(--fw-body)" }}>
          {T.shortcut}
        </span>
      </label>
      <div style={tightStackStyle}>
        <div style={chipRowStyle}>
          <PolicyGated action={MAIL_ACTIONS.send} resource={{ kind: "mail_attachment" }}>
            <label style={{ ...ghostButtonStyle, display: "inline-flex", alignItems: "center" }}>
              {T.attachFile}
              <input
                type="file"
                multiple
                style={hiddenFileInputStyle}
                onChange={(event) => {
                  onFilesSelected(Array.from(event.currentTarget.files ?? []));
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </PolicyGated>
          <StatusChip tone="neutral">{T.attachmentLimit}</StatusChip>
        </div>
        {attachments.length > 0 ? (
          <ul aria-label={T.selectedAttachments} style={{ ...tightStackStyle, margin: 0, padding: 0, listStyle: "none" }}>
            {attachments.map((file, index) => (
              <li
                key={`${file.name}-${String(file.size)}-${String(file.lastModified)}-${String(index)}`}
                style={{
                  ...rowStyle,
                  border: "1px solid var(--border-soft)",
                  borderRadius: "var(--radius)",
                  padding: "var(--sp-2) var(--sp-3)",
                }}
              >
                <span style={{ color: "var(--steel)", fontSize: "var(--text-sm)", fontWeight: "var(--fw-body)" }}>
                  {fileAttachmentLabel(file)}
                </span>
                <button
                  type="button"
                  style={ghostButtonStyle}
                  aria-label={T.removeAttachmentLabel(file.name)}
                  onClick={() => { onRemoveAttachment(file); }}
                >
                  {T.removeAttachment}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <EgressGatePanel block={egressBlock} />
      <PolicyGated action={MAIL_ACTIONS.send} resource={{ kind: "mail_message" }}>
        <button type="submit" style={primaryButtonStyle} disabled={sending}>
          {sendLabel}
        </button>
      </PolicyGated>
    </form>
  );
}
