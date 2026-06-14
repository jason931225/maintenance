import { Send } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useState } from "react";

import type {
  CustomerIntakeRequest,
  SupportTicketCategory,
  SupportTicketPriority,
} from "../../api/types";
import { Button } from "../../components/ui/button";
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

export type IntakeSubmitResult = "ok" | "rateLimited" | "error";

interface CustomerIntakeFormProps {
  onSubmit: (request: CustomerIntakeRequest) => Promise<IntakeSubmitResult>;
}

interface Errors {
  title?: string;
  body?: string;
  requesterName?: string;
  requesterContact?: string;
}

export function CustomerIntakeForm({ onSubmit }: CustomerIntakeFormProps) {
  const [category, setCategory] =
    useState<SupportTicketCategory>("EQUIPMENT_INQUIRY");
  const [priority, setPriority] = useState<SupportTicketPriority>("MEDIUM");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [requesterContact, setRequesterContact] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<
    "idle" | "saving" | "rateLimited" | "error"
  >("idle");

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Errors = {};
    if (title.trim().length === 0)
      nextErrors.title = ko.support.form.requiredTitle;
    if (body.trim().length === 0)
      nextErrors.body = ko.support.form.requiredBody;
    if (requesterName.trim().length === 0)
      nextErrors.requesterName = ko.support.form.requiredRequesterName;
    if (requesterContact.trim().length === 0)
      nextErrors.requesterContact = ko.support.form.requiredRequesterContact;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setStatus("saving");
    const result = await onSubmit({
      category,
      priority,
      title: title.trim(),
      body: body.trim(),
      requester_name: requesterName.trim(),
      requester_contact: requesterContact.trim(),
    });
    if (result === "ok") {
      // Parent swaps to the acknowledgement view; reset local fields anyway.
      setTitle("");
      setBody("");
      setRequesterName("");
      setRequesterContact("");
      setStatus("idle");
      return;
    }
    setStatus(result === "rateLimited" ? "rateLimited" : "error");
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <label
            className="text-sm font-medium text-slate-700"
            htmlFor="intake-category"
          >
            {ko.support.form.category}
          </label>
          <Select
            id="intake-category"
            value={category}
            onChange={(event) => {
              setCategory(event.currentTarget.value as SupportTicketCategory);
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
            className="text-sm font-medium text-slate-700"
            htmlFor="intake-priority"
          >
            {ko.support.form.priority}
          </label>
          <Select
            id="intake-priority"
            value={priority}
            onChange={(event) => {
              setPriority(event.currentTarget.value as SupportTicketPriority);
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

      <Field
        id="intake-title"
        label={ko.support.form.ticketTitle}
        placeholder={ko.support.form.titlePlaceholder}
        value={title}
        error={errors.title}
        onChange={setTitle}
      />

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-slate-700"
          htmlFor="intake-body"
        >
          {ko.support.form.body}
        </label>
        <Textarea
          id="intake-body"
          value={body}
          placeholder={ko.support.form.bodyPlaceholder}
          onChange={(event) => {
            setBody(event.currentTarget.value);
          }}
          aria-invalid={Boolean(errors.body)}
          aria-describedby={errors.body ? "intake-body-error" : undefined}
        />
        {errors.body ? (
          <p id="intake-body-error" className="text-sm font-medium text-red-700">
            {errors.body}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="intake-name"
          label={ko.support.form.requesterName}
          placeholder={ko.support.form.requesterNamePlaceholder}
          value={requesterName}
          error={errors.requesterName}
          onChange={setRequesterName}
        />
        <Field
          id="intake-contact"
          label={ko.support.form.requesterContact}
          placeholder={ko.support.form.requesterContactPlaceholder}
          value={requesterContact}
          error={errors.requesterContact}
          onChange={setRequesterContact}
        />
      </div>

      <Button type="submit" disabled={status === "saving"}>
        <Send aria-hidden="true" size={18} />
        {status === "saving"
          ? ko.support.form.submitting
          : ko.support.form.submit}
      </Button>
      {status === "rateLimited" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.support.form.rateLimited}
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.support.form.submitFailed}
        </p>
      ) : null}
    </form>
  );
}

function Field({
  id,
  label,
  placeholder,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  error?: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium text-slate-700" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
