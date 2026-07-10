import type { CSSProperties } from "react";

import { ko } from "../../i18n/ko";
import { StatusChip } from "../components";
import type { WorkflowRunEvent, WorkflowRunStatus } from "./types";

const T = ko.console.workflows;

type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-3)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const itemStyle: CSSProperties = {
  position: "relative",
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-4)",
  paddingInlineStart: "calc(var(--sp-6) + var(--sp-3))",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
};

const markerStyle: CSSProperties = {
  position: "absolute",
  insetBlockStart: "var(--sp-4)",
  insetInlineStart: "var(--sp-4)",
  width: 10,
  height: 10,
  borderRadius: "var(--radius-pill)",
  border: "2px solid var(--timeline-dot-bd)",
  background: "var(--timeline-dot-bg)",
};

const metaStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-medium)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-strong)",
};

const detailStyle: CSSProperties = {
  margin: 0,
  color: "var(--danger-tx)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-medium)",
};

const objectsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

function statusTone(status: WorkflowRunStatus): StatusTone {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "danger";
  if (status === "running") return "accent";
  if (status === "queued") return "info";
  if (status === "cancelled") return "warn";
  return "neutral";
}

export function RunLogTimeline({
  events,
  onRetry,
}: {
  events: WorkflowRunEvent[];
  onRetry?: (event: WorkflowRunEvent) => void;
}) {
  if (events.length === 0) {
    return <StatusChip tone="neutral">{T.timeline.empty}</StatusChip>;
  }

  return (
    <ol aria-label={T.timeline.title} style={listStyle}>
      {events.map((event) => (
        <li key={event.id} style={itemStyle}>
          <span aria-hidden="true" style={markerStyle} />
          <div style={metaStyle}>
            <StatusChip
              tone={statusTone(event.status)}
              role={event.status === "failed" ? "alert" : "status"}
              ariaLabel={T.status[event.status]}
            >
              {T.status[event.status]}
            </StatusChip>
            {event.code ? <StatusChip tone="neutral">{event.code}</StatusChip> : null}
            <span>{T.timeline.eventMeta(event.at, event.actor)}</span>
          </div>
          <p style={titleStyle}>{event.label}</p>
          {event.error ? <p style={detailStyle}>{event.error}</p> : null}
          {event.retryCount !== undefined ? (
            <StatusChip tone="warn">{T.timeline.retryCount(event.retryCount)}</StatusChip>
          ) : null}
          {event.generatedObjects && event.generatedObjects.length > 0 ? (
            <div aria-label={T.timeline.generatedObjects} style={objectsStyle}>
              {event.generatedObjects.map((objectCode) => (
                <StatusChip key={objectCode} tone="info">
                  {objectCode}
                </StatusChip>
              ))}
            </div>
          ) : null}
          {event.retryable ? (
            <button
              type="button"
              onClick={() => {
                onRetry?.(event);
              }}
              style={{ justifySelf: "start" }}
            >
              {T.actions.retry}
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
