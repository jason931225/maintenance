import { MessageSquarePlus, UserCheck } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useState } from "react";

import type {
  SupportTicketComment,
  SupportTicketDetail as SupportTicketDetailModel,
  SupportTicketStatus,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";
import {
  allowedTransitions,
  categoryLabel,
  formatDateTime,
  originLabel,
  priorityBadgeClass,
  priorityLabel,
  statusBadgeClass,
  statusLabel,
  transitionActionLabel,
} from "./support-format";

interface SupportTicketDetailProps {
  detail: SupportTicketDetailModel;
  /** Current principal — enables the self-assign ("claim") triage action. */
  currentUserId?: string;
  /**
   * Whether the principal may triage the ticket (assign/claim + status
   * transitions). These map to the backend `AssigneeManage` feature, which is
   * admin-only; mechanics can read + comment but never claim or transition, so
   * the triage controls are hidden from them rather than 403-ing on click.
   */
  canAssign: boolean;
  onTransition: (to: SupportTicketStatus) => Promise<void>;
  onAddComment: (body: string, isInternalNote: boolean) => Promise<void>;
  onAssignSelf: () => Promise<void>;
}

export function SupportTicketDetail({
  detail,
  currentUserId,
  canAssign,
  onTransition,
  onAddComment,
  onAssignSelf,
}: SupportTicketDetailProps) {
  const { ticket, comments } = detail;
  const transitions = allowedTransitions(ticket.status);

  // Track WHICH transition is in flight so only its button shows the busy
  // label (a single shared flag made every button show "changing" at once).
  const [pendingTo, setPendingTo] = useState<SupportTicketStatus | null>(null);
  const [transitionFailed, setTransitionFailed] = useState(false);
  const [assignState, setAssignState] = useState<"idle" | "busy" | "error">("idle");

  const alreadyMine =
    currentUserId !== undefined && ticket.assignee_user_id === currentUserId;

  async function handleTransition(to: SupportTicketStatus) {
    setPendingTo(to);
    setTransitionFailed(false);
    try {
      await onTransition(to);
    } catch {
      setTransitionFailed(true);
    } finally {
      setPendingTo(null);
    }
  }

  async function handleAssignSelf() {
    setAssignState("busy");
    try {
      await onAssignSelf();
      setAssignState("idle");
    } catch {
      setAssignState("error");
    }
  }

  return (
    <div className="grid gap-5">
      <Card className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={priorityBadgeClass(ticket.priority)}>
            {priorityLabel(ticket.priority)}
          </Badge>
          <Badge className={statusBadgeClass(ticket.status)}>
            {statusLabel(ticket.status)}
          </Badge>
          <Badge>{originLabel(ticket.origin)}</Badge>
          <Badge>{categoryLabel(ticket.category)}</Badge>
        </div>

        <h2 className="text-xl font-semibold text-slate-950">{ticket.title}</h2>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-slate-600">
              {ko.support.requester}
            </dt>
            <dd className="text-slate-950">
              {ticket.requester_name ?? ko.common.unknown}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-600">
              {ko.support.dueAt}
            </dt>
            <dd className="text-slate-950">{formatDateTime(ticket.due_at)}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-600">
              {ko.support.createdAt}
            </dt>
            <dd className="text-slate-950">
              {formatDateTime(ticket.created_at)}
            </dd>
          </div>
        </dl>

        {canAssign ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
          <span className="text-sm font-semibold text-slate-700">
            {ko.support.transition.title}
          </span>
          {transitions.length === 0 ? (
            <span className="text-sm text-slate-600">
              {ko.support.transition.none}
            </span>
          ) : (
            transitions.map((to) => (
              <Button
                key={to}
                type="button"
                variant="secondary"
                size="sm"
                disabled={pendingTo !== null}
                onClick={() => {
                  void handleTransition(to);
                }}
              >
                {pendingTo === to
                  ? ko.support.transition.changing
                  : transitionActionLabel(ticket.status, to)}
              </Button>
            ))
          )}
          {!alreadyMine ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={assignState === "busy"}
              onClick={() => {
                void handleAssignSelf();
              }}
            >
              <UserCheck aria-hidden="true" size={16} />
              {assignState === "busy"
                ? ko.support.assigning
                : ko.support.assignSelf}
            </Button>
          ) : null}
        </div>
        ) : null}
        {transitionFailed ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.support.transition.failed}
          </p>
        ) : null}
        {assignState === "error" ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.support.assignFailed}
          </p>
        ) : null}
      </Card>

      <Card className="grid gap-4">
        <h3 className="text-lg font-semibold text-slate-950">
          {ko.support.comments.title}
        </h3>
        <CommentThread comments={comments} />
        <AddCommentForm onAddComment={onAddComment} />
      </Card>
    </div>
  );
}

function CommentThread({ comments }: { comments: SupportTicketComment[] }) {
  if (comments.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
        {ko.support.comments.empty}
      </p>
    );
  }
  return (
    <ul className="grid gap-3">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className={`grid gap-1 rounded-md border p-3 ${
            comment.is_internal_note
              ? "border-amber-200 bg-amber-50"
              : "border-slate-200 bg-white"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            {comment.is_internal_note ? (
              <Badge className="border-amber-300 bg-amber-100 text-amber-900">
                {ko.support.comments.internalNote}
              </Badge>
            ) : null}
            <span className="text-xs text-slate-500">
              {formatDateTime(comment.created_at)}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-slate-900">
            {comment.body}
          </p>
        </li>
      ))}
    </ul>
  );
}

function AddCommentForm({
  onAddComment,
}: {
  onAddComment: (body: string, isInternalNote: boolean) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (body.trim().length === 0) {
      return;
    }
    setStatus("saving");
    try {
      await onAddComment(body.trim(), isInternal);
      setBody("");
      setIsInternal(false);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  return (
    <form
      className="grid gap-3 border-t border-slate-200 pt-4"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <label className="sr-only" htmlFor="support-comment-body">
        {ko.support.comments.title}
      </label>
      <Textarea
        id="support-comment-body"
        value={body}
        placeholder={ko.support.comments.placeholder}
        onChange={(event) => {
          setBody(event.currentTarget.value);
        }}
      />
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="size-4 rounded border-slate-300"
          checked={isInternal}
          onChange={(event) => {
            setIsInternal(event.currentTarget.checked);
          }}
        />
        {ko.support.comments.markInternal}
      </label>
      <Button
        type="submit"
        variant="secondary"
        disabled={status === "saving" || body.trim().length === 0}
        className="justify-self-start"
      >
        <MessageSquarePlus aria-hidden="true" size={18} />
        {status === "saving"
          ? ko.support.comments.adding
          : ko.support.comments.add}
      </Button>
      {status === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.support.comments.addFailed}
        </p>
      ) : null}
    </form>
  );
}
