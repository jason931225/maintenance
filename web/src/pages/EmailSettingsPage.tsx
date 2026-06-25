import { CheckCircle2, Mail, PlugZap, Save } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useState } from "react";

import type {
  ConfigureMailAccountRequest,
  MailAccountView,
  MailSecurity,
} from "../api/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { SkeletonCards } from "../components/states/Skeleton";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { useFeedback } from "../lib/useAutoDismiss";

/** Load lifecycle: the GET that hydrates the form. */
type LoadState =
  | { kind: "loading" }
  // No mailbox configured yet (HTTP 204): render an empty, first-time form.
  | { kind: "empty" }
  // A mailbox is on file (HTTP 200): the form is pre-filled.
  | { kind: "ready" }
  // The server has no master key (HTTP 503): the feature is unavailable.
  | { kind: "unavailable" }
  // The GET failed for another reason.
  | { kind: "error" };

/** Editable form model. Passwords are write-only and start blank. */
interface MailForm {
  displayName: string;
  emailAddress: string;
  fromName: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurity;
  smtpUsername: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurity;
  imapUsername: string;
  imapPassword: string;
}

const EMPTY_FORM: MailForm = {
  displayName: "",
  emailAddress: "",
  fromName: "",
  smtpHost: "",
  smtpPort: "465",
  smtpSecurity: "SSL_TLS",
  smtpUsername: "",
  smtpPassword: "",
  imapHost: "",
  imapPort: "993",
  imapSecurity: "SSL_TLS",
  imapUsername: "",
  imapPassword: "",
};

function formFromView(view: MailAccountView): MailForm {
  return {
    displayName: view.display_name,
    emailAddress: view.email_address,
    fromName: view.from_name ?? "",
    smtpHost: view.smtp_host,
    smtpPort: String(view.smtp_port),
    smtpSecurity: view.smtp_security,
    smtpUsername: view.smtp_username,
    smtpPassword: "",
    imapHost: view.imap_host,
    imapPort: String(view.imap_port),
    imapSecurity: view.imap_security,
    imapUsername: view.imap_username,
    imapPassword: "",
  };
}

/** A very light email-shape check — the backend remains the authority. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Maps a structured, non-secret error_code to friendly Korean copy. */
function testErrorMessage(code: string | null | undefined): string {
  const map = ko.email.errorCodes;
  if (code && code in map) {
    return map[code as keyof typeof map];
  }
  return map.unknown;
}

export function EmailSettingsPage() {
  const { api } = useAuth();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [form, setForm] = useState<MailForm>(EMPTY_FORM);
  // Whether a credential is already sealed on the server. Drives the
  // already-set affordance and the keep-existing placeholder; the password
  // itself is never returned.
  const [hasSmtpPassword, setHasSmtpPassword] = useState(false);
  const [hasImapPassword, setHasImapPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof MailForm, string>>
  >({});
  const { feedback, error, showFeedback, showError, reset } = useFeedback();

  // A mailbox is configured (HTTP 200) — credentials may already be sealed, so
  // the password fields are optional on save.
  const isConfigured = load.kind === "ready";

  const loadAccount = useCallback(async () => {
    setLoad({ kind: "loading" });
    const res = await api.GET("/api/v1/mail/account").catch(() => undefined);
    if (!res) {
      setLoad({ kind: "error" });
      return;
    }
    const status = res.response.status;
    if (status === 503) {
      setLoad({ kind: "unavailable" });
      return;
    }
    if (status === 204) {
      setForm(EMPTY_FORM);
      setHasSmtpPassword(false);
      setHasImapPassword(false);
      setLoad({ kind: "empty" });
      return;
    }
    if (res.data) {
      setForm(formFromView(res.data));
      setHasSmtpPassword(res.data.has_smtp_password);
      setHasImapPassword(res.data.has_imap_password);
      setLoad({ kind: "ready" });
      return;
    }
    setLoad({ kind: "error" });
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadAccount);
  }, [loadAccount]);

  const setField = useCallback(
    <K extends keyof MailForm>(key: K, value: MailForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  // Validate the form. Passwords are required only on a first-time configure
  // (no sealed credential to keep). Returns the field-error map.
  const validate = useCallback((): Partial<Record<keyof MailForm, string>> => {
    const v = ko.email.validation;
    const next: Partial<Record<keyof MailForm, string>> = {};
    if (!form.displayName.trim()) next.displayName = v.displayNameRequired;
    if (!form.emailAddress.trim()) next.emailAddress = v.emailRequired;
    else if (!looksLikeEmail(form.emailAddress))
      next.emailAddress = v.emailInvalid;

    if (!form.smtpHost.trim()) next.smtpHost = v.hostRequired;
    const smtpPort = Number(form.smtpPort);
    if (
      !form.smtpPort.trim() ||
      !Number.isInteger(smtpPort) ||
      smtpPort < 1 ||
      smtpPort > 65535
    )
      next.smtpPort = v.portRange;
    if (!form.smtpUsername.trim()) next.smtpUsername = v.usernameRequired;
    if (!hasSmtpPassword && !form.smtpPassword)
      next.smtpPassword = v.passwordRequired;

    if (!form.imapHost.trim()) next.imapHost = v.hostRequired;
    const imapPort = Number(form.imapPort);
    if (
      !form.imapPort.trim() ||
      !Number.isInteger(imapPort) ||
      imapPort < 1 ||
      imapPort > 65535
    )
      next.imapPort = v.portRange;
    if (!form.imapUsername.trim()) next.imapUsername = v.usernameRequired;
    if (!hasImapPassword && !form.imapPassword)
      next.imapPassword = v.passwordRequired;

    return next;
  }, [form, hasSmtpPassword, hasImapPassword]);

  // Build the PUT body. An empty password field is OMITTED so the stored secret
  // is kept; a non-empty value re-seals it.
  const buildRequest = useCallback((): ConfigureMailAccountRequest => {
    const body: ConfigureMailAccountRequest = {
      display_name: form.displayName.trim(),
      email_address: form.emailAddress.trim(),
      from_name: form.fromName.trim() ? form.fromName.trim() : null,
      smtp_host: form.smtpHost.trim(),
      smtp_port: Number(form.smtpPort),
      smtp_security: form.smtpSecurity,
      smtp_username: form.smtpUsername.trim(),
      imap_host: form.imapHost.trim(),
      imap_port: Number(form.imapPort),
      imap_security: form.imapSecurity,
      imap_username: form.imapUsername.trim(),
    };
    if (form.smtpPassword) body.smtp_password = form.smtpPassword;
    if (form.imapPassword) body.imap_password = form.imapPassword;
    return body;
  }, [form]);

  const handleSave = useCallback(async () => {
    reset();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const res = await api
        .PUT("/api/v1/mail/account", { body: buildRequest() })
        .catch(() => undefined);
      if (!res || !res.data) {
        if (res && res.response.status === 503) {
          setLoad({ kind: "unavailable" });
          return;
        }
        showError(ko.email.saveFailed);
        return;
      }
      // Re-hydrate from the authoritative view: the password fields clear and
      // the already-set indicators reflect the freshly-sealed credentials.
      setForm(formFromView(res.data));
      setHasSmtpPassword(res.data.has_smtp_password);
      setHasImapPassword(res.data.has_imap_password);
      setLoad({ kind: "ready" });
      showFeedback(ko.email.saved);
    } finally {
      setSaving(false);
    }
  }, [api, buildRequest, validate, reset, showError, showFeedback]);

  const handleTest = useCallback(async () => {
    reset();
    setTesting(true);
    try {
      const res = await api
        .POST("/api/v1/mail/account/test", {})
        .catch(() => undefined);
      if (!res || !res.data) {
        if (res && res.response.status === 429) {
          showError(ko.email.testRateLimited);
          return;
        }
        if (res && res.response.status === 503) {
          setLoad({ kind: "unavailable" });
          return;
        }
        showError(ko.email.testFailed);
        return;
      }
      if (res.data.ok) {
        showFeedback(ko.email.testOk);
        return;
      }
      showError(testErrorMessage(res.data.error_code));
    } finally {
      setTesting(false);
    }
  }, [api, reset, showError, showFeedback]);

  return (
    <>
      <PageHeader title={ko.email.title} description={ko.email.description} />

      {load.kind === "loading" ? (
        <div className="max-w-2xl">
          <SkeletonCards count={3} lines={4} />
        </div>
      ) : load.kind === "unavailable" ? (
        <div className="max-w-2xl">
          <Card className="grid gap-2">
            <div className="flex items-center gap-2 text-ink">
              <Mail aria-hidden="true" size={20} />
              <h2 className="text-lg font-semibold">
                {ko.email.notConfiguredTitle}
              </h2>
            </div>
            <p className="text-sm text-steel">{ko.email.notConfiguredBody}</p>
          </Card>
        </div>
      ) : load.kind === "error" ? (
        <div className="max-w-2xl">
          <Card className="grid gap-3">
            <p role="alert" className="text-sm font-medium text-red-700">
              {ko.email.loadFailed}
            </p>
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void loadAccount();
                }}
              >
                {ko.page.retry}
              </Button>
            </div>
          </Card>
        </div>
      ) : (
        <form
          className="grid max-w-2xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          noValidate
        >
          <FeedbackBanner
            message={feedback}
            kind="success"
            onDismiss={reset}
          />
          <FeedbackBanner message={error} kind="error" onDismiss={reset} />

          <IdentitySection
            form={form}
            errors={fieldErrors}
            onChange={setField}
          />

          <ServerSection
            kind="smtp"
            form={form}
            errors={fieldErrors}
            hasPassword={hasSmtpPassword}
            isConfigured={isConfigured}
            onChange={setField}
          />

          <ServerSection
            kind="imap"
            form={form}
            errors={fieldErrors}
            hasPassword={hasImapPassword}
            isConfigured={isConfigured}
            onChange={setField}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              <Save aria-hidden="true" size={18} />
              {saving ? ko.email.saving : ko.email.save}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={testing || saving || !isConfigured}
              onClick={() => {
                void handleTest();
              }}
            >
              <PlugZap aria-hidden="true" size={18} />
              {testing ? ko.email.testing : ko.email.test}
            </Button>
            {!isConfigured ? (
              <span className="text-sm text-steel">
                {ko.email.testRequiresSave}
              </span>
            ) : null}
          </div>
        </form>
      )}
    </>
  );
}

interface SectionProps {
  form: MailForm;
  errors: Partial<Record<keyof MailForm, string>>;
  onChange: <K extends keyof MailForm>(key: K, value: MailForm[K]) => void;
}

/** The shared identity block: display name, from-address, optional from-name. */
function IdentitySection({ form, errors, onChange }: SectionProps) {
  const displayNameId = useId();
  const emailId = useId();
  const fromNameId = useId();
  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold text-ink">
          {ko.email.identitySection}
        </h2>
      </div>
      <Field
        id={displayNameId}
        label={ko.email.displayName}
        error={errors.displayName}
      >
        <Input
          id={displayNameId}
          value={form.displayName}
          placeholder={ko.email.displayNamePlaceholder}
          aria-invalid={errors.displayName ? true : undefined}
          onChange={(e) => {
            onChange("displayName", e.target.value);
          }}
        />
      </Field>
      <Field
        id={emailId}
        label={ko.email.emailAddress}
        error={errors.emailAddress}
      >
        <Input
          id={emailId}
          type="email"
          value={form.emailAddress}
          placeholder={ko.email.emailAddressPlaceholder}
          aria-invalid={errors.emailAddress ? true : undefined}
          onChange={(e) => {
            onChange("emailAddress", e.target.value);
          }}
        />
      </Field>
      <Field id={fromNameId} label={ko.email.fromName}>
        <Input
          id={fromNameId}
          value={form.fromName}
          placeholder={ko.email.fromNamePlaceholder}
          onChange={(e) => {
            onChange("fromName", e.target.value);
          }}
        />
      </Field>
    </Card>
  );
}

interface ServerSectionProps extends SectionProps {
  kind: "smtp" | "imap";
  hasPassword: boolean;
  isConfigured: boolean;
}

/** A SMTP or IMAP server block: host, port, security, username, password. */
function ServerSection({
  kind,
  form,
  errors,
  hasPassword,
  isConfigured,
  onChange,
}: ServerSectionProps) {
  const hostId = useId();
  const portId = useId();
  const securityId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const passwordHintId = useId();

  const isSmtp = kind === "smtp";
  const hostField = isSmtp ? "smtpHost" : "imapHost";
  const portField = isSmtp ? "smtpPort" : "imapPort";
  const securityField = isSmtp ? "smtpSecurity" : "imapSecurity";
  const usernameField = isSmtp ? "smtpUsername" : "imapUsername";
  const passwordField = isSmtp ? "smtpPassword" : "imapPassword";

  // On a first-time configure the password is required; once sealed it may be
  // left blank to keep the stored secret.
  const passwordPlaceholder = hasPassword
    ? ko.email.passwordKeepPlaceholder
    : ko.email.passwordNewPlaceholder;
  const passwordHint = hasPassword
    ? ko.email.passwordSetHint
    : isConfigured
      ? undefined
      : ko.email.passwordRequiredHint;

  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold text-ink">
          {isSmtp ? ko.email.smtpSection : ko.email.imapSection}
        </h2>
        <p className="text-sm text-steel">
          {isSmtp ? ko.email.smtpSectionHint : ko.email.imapSectionHint}
        </p>
      </div>

      <Field id={hostId} label={ko.email.host} error={errors[hostField]}>
        <Input
          id={hostId}
          value={form[hostField]}
          placeholder={ko.email.hostPlaceholder}
          autoComplete="off"
          aria-invalid={errors[hostField] ? true : undefined}
          onChange={(e) => {
            onChange(hostField, e.target.value);
          }}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={portId} label={ko.email.port} error={errors[portField]}>
          <Input
            id={portId}
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={form[portField]}
            placeholder={ko.email.portPlaceholder}
            aria-invalid={errors[portField] ? true : undefined}
            onChange={(e) => {
              onChange(portField, e.target.value);
            }}
          />
        </Field>
        <Field id={securityId} label={ko.email.security}>
          <Select
            id={securityId}
            value={form[securityField]}
            onChange={(e) => {
              onChange(securityField, e.target.value as MailSecurity);
            }}
          >
            <option value="SSL_TLS">{ko.email.securitySslTls}</option>
            <option value="START_TLS">{ko.email.securityStartTls}</option>
          </Select>
        </Field>
      </div>

      <Field
        id={usernameId}
        label={ko.email.username}
        error={errors[usernameField]}
      >
        <Input
          id={usernameId}
          value={form[usernameField]}
          placeholder={ko.email.usernamePlaceholder}
          autoComplete="off"
          aria-invalid={errors[usernameField] ? true : undefined}
          onChange={(e) => {
            onChange(usernameField, e.target.value);
          }}
        />
      </Field>

      <Field
        id={passwordId}
        label={ko.email.password}
        error={errors[passwordField]}
        labelAddon={
          hasPassword ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-teal">
              <CheckCircle2 aria-hidden="true" size={14} />
              {ko.email.passwordSet}
            </span>
          ) : null
        }
        hint={passwordHint}
        hintId={passwordHintId}
      >
        <Input
          id={passwordId}
          type="password"
          value={form[passwordField]}
          placeholder={passwordPlaceholder}
          autoComplete="new-password"
          aria-describedby={passwordHint ? passwordHintId : undefined}
          aria-invalid={errors[passwordField] ? true : undefined}
          onChange={(e) => {
            onChange(passwordField, e.target.value);
          }}
        />
      </Field>
    </Card>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  hintId?: string;
  labelAddon?: ReactNode;
  children: ReactNode;
}

/** A labelled form field with an optional inline addon, hint, and error. */
function Field({
  id,
  label,
  error,
  hint,
  hintId,
  labelAddon,
  children,
}: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-steel" htmlFor={id}>
          {label}
        </label>
        {labelAddon}
      </div>
      {children}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-steel">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
