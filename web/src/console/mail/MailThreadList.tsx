import type { KeyboardEvent } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import { PolicyGated } from "../policy";
import { formatMailDate } from "./format";
import { MAIL_ACTIONS, threadChips } from "./mailScreenConfig";
import {
  buttonBaseStyle,
  chipRowStyle,
  faintTextStyle,
  ghostButtonStyle,
  inputStyle,
  rowStyle,
  sectionTitleStyle,
  separatorPaneStyle,
  stackStyle,
  statusRowStyle,
} from "./styles";
import type { ConsoleMailThread } from "./types";

export function MailThreadList({
  threads,
  selectedThreadId,
  queryDraft,
  unreadOnly,
  loadState,
  onQueryDraftChange,
  onSubmitSearch,
  onUnreadOnlyChange,
  onSelectThread,
  onOpenThread,
}: {
  threads: ConsoleMailThread[];
  selectedThreadId?: string;
  queryDraft: string;
  unreadOnly: boolean;
  loadState: "loading" | "ready" | "empty" | "error" | "unavailable" | "not_configured";
  onQueryDraftChange: (value: string) => void;
  onSubmitSearch: () => void;
  onUnreadOnlyChange: (value: boolean) => void;
  onSelectThread: (thread: ConsoleMailThread) => void;
  onOpenThread: (thread: ConsoleMailThread) => void;
}) {
  const T = ko.console.mail;
  const selectedIndex = Math.max(0, threads.findIndex((thread) => thread.id === selectedThreadId));

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (threads.length === 0) return;
    const key = event.key.toLowerCase();
    if (key !== "j" && key !== "k" && event.key !== "Enter") return;
    event.preventDefault();
    if (event.key === "Enter") {
      onOpenThread(threads[selectedIndex] ?? threads[0]);
      return;
    }
    const direction = key === "j" ? 1 : -1;
    const nextIndex = Math.min(threads.length - 1, Math.max(0, selectedIndex + direction));
    onSelectThread(threads[nextIndex]);
  }

  return (
    <section className="mail-screen__threads" style={separatorPaneStyle}>
      <div style={rowStyle}>
        <h2 style={sectionTitleStyle}>{T.thread.listLabel}</h2>
        <label style={{ ...faintTextStyle, display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => { onUnreadOnlyChange(event.currentTarget.checked); }}
          />
          {T.filter.unreadOnly}
        </label>
      </div>
      <form
        style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "var(--sp-2)" }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitSearch();
        }}
      >
        <label style={{ display: "block" }}>
          <span style={faintTextStyle}>{T.search.label}</span>
          <input
            type="search"
            aria-label={T.search.label}
            placeholder={T.search.placeholder}
            value={queryDraft}
            style={inputStyle}
            onChange={(event) => { onQueryDraftChange(event.currentTarget.value); }}
          />
        </label>
        <PolicyGated action={MAIL_ACTIONS.read} resource={{ kind: "mail_thread_search" }}>
          <button type="submit" style={ghostButtonStyle} aria-label={T.search.submit}>
            {T.search.submit}
          </button>
        </PolicyGated>
      </form>
      {loadState === "empty" ? (
        <div role="status" style={statusRowStyle}>{T.thread.empty}</div>
      ) : (
        <div role="list" aria-label={T.thread.listLabel} tabIndex={0} style={stackStyle} onKeyDown={handleKeyDown}>
          {threads.map((thread) => {
            const selected = thread.id === selectedThreadId;
            const subject = thread.subject || T.thread.noSubject;
            return (
              <PolicyGated key={thread.id} action={MAIL_ACTIONS.read} resource={{ kind: "mail_thread", id: thread.id }}>
                <button
                  type="button"
                  role="listitem"
                  aria-current={selected ? "true" : undefined}
                  style={{
                    ...buttonBaseStyle,
                    minHeight: "auto",
                    display: "grid",
                    width: "100%",
                    gap: "var(--sp-2)",
                    padding: "var(--sp-3)",
                    textAlign: "left",
                    borderColor: selected ? "var(--ink)" : "var(--border-soft)",
                    background: selected ? "var(--muted)" : "var(--surface)",
                  }}
                  onClick={() => { onSelectThread(thread); }}
                >
                  <span style={rowStyle}>
                    <span style={{ color: "var(--ink)", fontSize: "var(--text-sm)", fontWeight: thread.unread_count > 0 ? "var(--fw-strong)" : "var(--fw-medium)" }}>
                      {subject}
                    </span>
                    <span style={{ ...faintTextStyle, fontFamily: "var(--font-mono)" }}>{formatMailDate(thread.last_message_at)}</span>
                  </span>
                  <span style={chipRowStyle}>
                    {threadChips(thread).map((chip) => (
                      <StatusChip key={chip.key} tone={chip.tone} role={chip.role}>
                        {chip.label}
                      </StatusChip>
                    ))}
                  </span>
                </button>
              </PolicyGated>
            );
          })}
        </div>
      )}
    </section>
  );
}
