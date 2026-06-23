import { Save } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useState } from "react";

import type {
  CreateInternalTicketRequest,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketSummary,
} from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";
import {
  categoryLabel,
  priorityLabel,
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
} from "./support-format";

interface CreateTicketFormProps {
  branchId: string;
  onCreate: (
    request: CreateInternalTicketRequest,
  ) => Promise<SupportTicketSummary>;
  onCreated?: (ticket: SupportTicketSummary) => void;
}

interface Errors {
  title?: string;
  body?: string;
}

export function CreateTicketForm({
  branchId,
  onCreate,
  onCreated,
}: CreateTicketFormProps) {
  const [category, setCategory] = useState<SupportTicketCategory>("OPERATIONAL");
  const [priority, setPriority] = useState<SupportTicketPriority>("MEDIUM");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<"idle" | "saving" | "created" | "error">(
    "idle",
  );

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Errors = {};
    if (title.trim().length === 0) {
      nextErrors.title = ko.support.form.requiredTitle;
    }
    if (body.trim().length === 0) {
      nextErrors.body = ko.support.form.requiredBody;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setStatus("saving");
    try {
      const created = await onCreate({
        branch_id: branchId,
        category,
        priority,
        title: title.trim(),
        body: body.trim(),
      });
      setStatus("created");
      setTitle("");
      setBody("");
      onCreated?.(created);
    } catch {
      setStatus("error");
    }
  }

  return (
    <Card>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <h2 className="text-lg font-semibold text-ink">
          {ko.support.createTitle}
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="ticket-category"
            >
              {ko.support.form.category}
            </label>
            <Select
              id="ticket-category"
              value={category}
              onChange={(event) => {
                setCategory(
                  event.currentTarget.value as SupportTicketCategory,
                );
              }}
            >
              {SUPPORT_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {categoryLabel(value)}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="ticket-priority"
            >
              {ko.support.form.priority}
            </label>
            <Select
              id="ticket-priority"
              value={priority}
              onChange={(event) => {
                setPriority(
                  event.currentTarget.value as SupportTicketPriority,
                );
              }}
            >
              {SUPPORT_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {priorityLabel(value)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid gap-2">
          <label
            className="text-sm font-medium text-steel"
            htmlFor="ticket-title"
          >
            {ko.support.form.ticketTitle}
          </label>
          <Input
            id="ticket-title"
            value={title}
            placeholder={ko.support.form.titlePlaceholder}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
            aria-invalid={Boolean(errors.title)}
            aria-describedby={errors.title ? "ticket-title-error" : undefined}
          />
          {errors.title ? (
            <p
              id="ticket-title-error"
              className="text-sm font-medium text-red-700"
            >
              {errors.title}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <label
            className="text-sm font-medium text-steel"
            htmlFor="ticket-body"
          >
            {ko.support.form.body}
          </label>
          <Textarea
            id="ticket-body"
            value={body}
            placeholder={ko.support.form.bodyPlaceholder}
            onChange={(event) => {
              setBody(event.currentTarget.value);
            }}
            aria-invalid={Boolean(errors.body)}
            aria-describedby={errors.body ? "ticket-body-error" : undefined}
          />
          {errors.body ? (
            <p
              id="ticket-body-error"
              className="text-sm font-medium text-red-700"
            >
              {errors.body}
            </p>
          ) : null}
        </div>

        <Button type="submit" disabled={status === "saving"}>
          <Save aria-hidden="true" size={18} />
          {status === "saving"
            ? ko.support.form.submitting
            : ko.support.form.submit}
        </Button>
        {status === "created" ? (
          <p role="status" className="text-sm font-semibold text-brand-teal">
            {ko.support.form.created}
          </p>
        ) : null}
        {status === "error" ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.support.form.submitFailed}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
