import { Loader2, Send } from "lucide-react";
import type { Ref, SyntheticEvent } from "react";
import { useRef, useState } from "react";

import type {
  CustomerIntakeRequest,
  SupportTicketCategory,
  SupportTicketPriority,
} from "../../api/types";
import { ko } from "../../i18n/ko";

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

const f = ko.support.form;

// Customer-facing category choices (plain language → SupportTicketCategory).
// The internal-only categories (SYSTEM_BUG / ACCESS_REQUEST) are not offered to
// public customers, so only the categoryOptions keys are presented. Default
// stays EQUIPMENT_INQUIRY.
type CustomerCategory = keyof typeof f.categoryOptions;

const CATEGORY_CHOICES: ReadonlyArray<CustomerCategory> = [
  "EQUIPMENT_INQUIRY",
  "OPERATIONAL",
  "COMPLAINT",
  "OTHER",
];

// Priority choices in plain customer language. Default stays MEDIUM.
const PRIORITY_CHOICES: ReadonlyArray<SupportTicketPriority> = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
];

// Shared KNL-token field classes (storefront look — not the console slate
// primitives). Hand-written so the public form matches the home page.
const FIELD_CLASS =
  "min-h-[48px] w-full rounded border border-line bg-white px-3.5 text-[16px] text-ink outline-none transition-colors focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-invalid:border-red-600";

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

  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const contactRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Errors = {};
    if (title.trim().length === 0) nextErrors.title = f.requiredTitle;
    if (body.trim().length === 0) nextErrors.body = f.requiredBody;
    if (requesterName.trim().length === 0)
      nextErrors.requesterName = f.requiredRequesterName;
    if (requesterContact.trim().length === 0)
      nextErrors.requesterContact = f.requiredRequesterContact;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // Move focus to the first invalid field so the error is announced.
      if (nextErrors.title) titleRef.current?.focus();
      else if (nextErrors.body) bodyRef.current?.focus();
      else if (nextErrors.requesterName) nameRef.current?.focus();
      else if (nextErrors.requesterContact) contactRef.current?.focus();
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

  const saving = status === "saving";
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form
      aria-label={ko.support.intake.formAria}
      className="grid gap-5"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label
            className="text-[13px] font-black uppercase tracking-[0.08em] text-steel"
            htmlFor="intake-category"
          >
            {f.category}
          </label>
          <select
            id="intake-category"
            value={category}
            onChange={(event) => {
              setCategory(event.currentTarget.value as SupportTicketCategory);
            }}
            aria-describedby="intake-category-help"
            className={FIELD_CLASS}
          >
            {CATEGORY_CHOICES.map((value) => (
              <option key={value} value={value}>
                {f.categoryOptions[value]}
              </option>
            ))}
          </select>
          <p id="intake-category-help" className="text-[13px] text-steel">
            {f.categoryHelp}
          </p>
        </div>
        <div className="grid gap-1.5">
          <label
            className="text-[13px] font-black uppercase tracking-[0.08em] text-steel"
            htmlFor="intake-priority"
          >
            {f.priority}
          </label>
          <select
            id="intake-priority"
            value={priority}
            onChange={(event) => {
              setPriority(event.currentTarget.value as SupportTicketPriority);
            }}
            aria-describedby="intake-priority-help"
            className={FIELD_CLASS}
          >
            {PRIORITY_CHOICES.map((value) => (
              <option key={value} value={value}>
                {f.priorityOptions[value]}
              </option>
            ))}
          </select>
          <p id="intake-priority-help" className="text-[13px] text-steel">
            {f.priorityHelp}
          </p>
        </div>
      </div>

      <Field
        id="intake-title"
        label={f.ticketTitle}
        placeholder={f.titlePlaceholder}
        help={f.titleHelp}
        value={title}
        error={errors.title}
        inputRef={titleRef}
        onChange={setTitle}
      />

      <div className="grid gap-1.5">
        <label
          className="text-[13px] font-black uppercase tracking-[0.08em] text-steel"
          htmlFor="intake-body"
        >
          {f.body}
        </label>
        <textarea
          id="intake-body"
          ref={bodyRef}
          rows={5}
          value={body}
          placeholder={f.bodyPlaceholder}
          onChange={(event) => {
            setBody(event.currentTarget.value);
          }}
          aria-invalid={Boolean(errors.body)}
          aria-describedby={
            errors.body ? "intake-body-error" : "intake-body-help"
          }
          className={`${FIELD_CLASS} min-h-[120px] py-3 leading-[1.6]`}
        />
        {errors.body ? (
          <p
            id="intake-body-error"
            role="alert"
            className="text-[14px] font-bold text-red-700"
          >
            {errors.body}
          </p>
        ) : (
          <p id="intake-body-help" className="text-[13px] text-steel">
            {f.bodyHelp}
          </p>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="intake-name"
          label={f.requesterName}
          placeholder={f.requesterNamePlaceholder}
          value={requesterName}
          error={errors.requesterName}
          inputRef={nameRef}
          onChange={setRequesterName}
        />
        <Field
          id="intake-contact"
          label={f.requesterContact}
          placeholder={f.requesterContactPlaceholder}
          help={f.contactHelp}
          value={requesterContact}
          error={errors.requesterContact}
          inputRef={contactRef}
          onChange={setRequesterContact}
        />
      </div>

      {hasErrors ? (
        <p role="alert" className="text-[14px] font-bold text-red-700">
          {f.errorSummary}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving}
        className="inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded bg-signal px-6 font-black text-ink transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60 motion-safe:hover:-translate-y-0.5"
      >
        {saving ? (
          <Loader2
            aria-hidden="true"
            size={18}
            className="motion-safe:animate-spin"
          />
        ) : (
          <Send aria-hidden="true" size={18} />
        )}
        {saving ? f.submitting : f.submit}
      </button>
      {status === "rateLimited" ? (
        <p role="alert" className="text-[14px] font-bold text-red-700">
          {f.rateLimited}
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="text-[14px] font-bold text-red-700">
          {f.submitFailed}
        </p>
      ) : null}
    </form>
  );
}

function Field({
  id,
  label,
  placeholder,
  help,
  value,
  error,
  inputRef,
  onChange,
}: {
  id: string;
  label: string;
  placeholder?: string;
  help?: string;
  value: string;
  error?: string;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (next: string) => void;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="grid gap-1.5">
      <label
        className="text-[13px] font-black uppercase tracking-[0.08em] text-steel"
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        aria-invalid={Boolean(error)}
        aria-describedby={errorId ?? helpId}
        className={FIELD_CLASS}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-[14px] font-bold text-red-700">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="text-[13px] text-steel">
          {help}
        </p>
      ) : null}
    </div>
  );
}
