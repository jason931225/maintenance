import { ko } from "../../../i18n/ko";
import { resolveRowTitle } from "../../../lib/rowTitle";
import { StatusChip } from "../../components";
import {
  actionInboxDue,
  actionInboxDoneTone,
  actionInboxLinkRoute,
  actionInboxTone,
  actionStatusLabel,
  kindLabel,
  urgencyLabel,
  type ActionInboxItem,
  type MyWorkStrings,
} from "./myWorkModel";
import "./MyWorkDetailPanel.css";

interface MyWorkDetailPanelProps {
  detailId: string;
  item: ActionInboxItem;
  dueFmt: Intl.DateTimeFormat;
  onClose: () => void;
  onOpen: (item: ActionInboxItem) => void;
  strings: MyWorkStrings;
}

/**
 * Read-only detail for one server-owned action-inbox item. It intentionally
 * renders only payload fields and keeps unregistered source links inert.
 */
export function MyWorkDetailPanel({
  detailId,
  item,
  dueFmt,
  onClose,
  onOpen,
  strings: S,
}: MyWorkDetailPanelProps) {
  const resolved = resolveRowTitle(item.title, item.ref, item.site ?? kindLabel(item.kind, S));
  const due = actionInboxDue(item.due);
  const submitted = actionInboxDue(item.submitted);
  const destination = actionInboxLinkRoute(item);
  const rawLinks = Array.isArray(item.links)
    ? item.links.filter(
        (link): link is { kind: string; id: string } =>
          typeof link === "object" &&
          link !== null &&
          typeof (link as { kind?: unknown }).kind === "string" &&
          typeof (link as { id?: unknown }).id === "string",
      )
    : [];

  return (
    <aside id={detailId} className="mywork-detail" aria-label={resolved.title}>
      <div className="mywork-detail__head">
        <h3 className="mywork-detail__title">{resolved.title}</h3>
        <button
          type="button"
          data-window-control="true"
          aria-label={ko.common.close}
          className="mywork-detail__close"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="mywork-detail__chips">
        <StatusChip tone={actionInboxDoneTone(item.done)}>{kindLabel(item.kind, S)}</StatusChip>
        <StatusChip tone={actionInboxTone(item.dueTone)}>{urgencyLabel(item.urg, S)}</StatusChip>
        <StatusChip tone={actionInboxDoneTone(item.done)}>{actionStatusLabel(item.done, S)}</StatusChip>
      </div>
      <dl className="mywork-detail__list">
        <DetailValue label={ko.equipment.detail.referenceTitle} value={item.ref} mono />
        {item.site ? <DetailValue label={ko.common.branch} value={item.site} /> : null}
        {item.who ? <DetailValue label={ko.console.module.support.kv.assignee} value={item.who} /> : null}
        {due ? (
          <DetailValue label={ko.console.workspace.field.due} value={dueFmt.format(due)} time={item.due} />
        ) : item.due != null ? (
          <DetailValue label={ko.console.workspace.field.due} value={S.assigned.dueUnavailable} />
        ) : null}
        {submitted ? (
          <DetailValue label={ko.console.workspace.field.occurredAt} value={dueFmt.format(submitted)} time={item.submitted} />
        ) : null}
        {rawLinks.map((link) => (
          <DetailValue key={`${link.kind}:${link.id}`} label={link.kind} value={link.id} mono />
        ))}
      </dl>
      <button
        type="button"
        data-window-control="true"
        className="mywork-detail__open"
        disabled={!destination}
        onClick={() => {
          onOpen(item);
        }}
      >
        {S.assigned.open}
      </button>
    </aside>
  );
}

function DetailValue({
  label,
  value,
  mono = false,
  time,
}: {
  label: string;
  value: string;
  mono?: boolean;
  time?: string;
}) {
  return (
    <div className="mywork-detail__value">
      <dt className="mywork-detail__key">{label}</dt>
      <dd className={mono ? "mywork-detail__text mywork-detail__text--mono" : "mywork-detail__text"}>
        {time ? <time dateTime={time}>{value}</time> : value}
      </dd>
    </div>
  );
}
