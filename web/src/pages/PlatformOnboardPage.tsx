import { AlertTriangle, Building2, Check, Copy } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { onboardPlatformOrg, PlatformApiError } from "../api/platform";
import type { OnboardOrgResponse } from "../api/platform";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

// Lowercase, digits, and single hyphens — matches the backend slug constraint.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function PlatformOnboardPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<OnboardOrgResponse | undefined>(
    undefined,
  );

  async function handleSubmit() {
    setError(undefined);
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName) {
      setError(ko.platform.onboard.form.requiredName);
      return;
    }
    if (!SLUG_PATTERN.test(trimmedSlug)) {
      setError(ko.platform.onboard.form.invalidSlug);
      return;
    }
    setPending(true);
    try {
      const response = await onboardPlatformOrg(token, {
        name: trimmedName,
        slug: trimmedSlug,
      });
      setResult(response);
    } catch (err) {
      if (err instanceof PlatformApiError && err.status === 409) {
        setError(ko.platform.onboard.form.duplicateSlug);
      } else if (
        err instanceof PlatformApiError &&
        (err.status === 400 || err.status === 422)
      ) {
        setError(ko.platform.onboard.form.invalidSlug);
      } else {
        setError(ko.platform.onboard.form.failed);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title={ko.platform.onboard.title}
        description={ko.platform.onboard.description}
      />

      {result ? (
        <OnboardResult
          result={result}
          onDone={() => {
            void navigate("/platform/tenants");
          }}
        />
      ) : (
        <Card className="grid max-w-lg gap-4">
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="org-name"
            >
              {ko.platform.onboard.form.name}
            </label>
            <Input
              id="org-name"
              value={name}
              placeholder={ko.platform.onboard.form.namePlaceholder}
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
            />
          </div>

          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="org-slug"
            >
              {ko.platform.onboard.form.slug}
            </label>
            <Input
              id="org-slug"
              value={slug}
              placeholder={ko.platform.onboard.form.slugPlaceholder}
              onChange={(event) => {
                setSlug(event.currentTarget.value);
              }}
            />
            <p className="text-xs text-steel">
              {ko.platform.onboard.form.slugHint}
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                void handleSubmit();
              }}
            >
              <Building2 aria-hidden="true" size={18} />
              {pending
                ? ko.platform.onboard.form.submitting
                : ko.platform.onboard.form.submit}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

function OnboardResult({
  result,
  onDone,
}: {
  result: OnboardOrgResponse;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(result.otp);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card className="grid max-w-lg gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold text-ink">
          {ko.platform.onboard.success.title}
        </h2>
        <p className="text-sm text-steel">
          {ko.platform.onboard.success.subtitle
            .replace("{name}", result.org.name)
            .replace("{slug}", result.org.slug)}
        </p>
      </div>

      <div className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
          <AlertTriangle aria-hidden="true" size={16} />
          {ko.platform.onboard.success.otpHeading}
        </div>
        <p className="text-sm text-amber-900">
          {ko.platform.onboard.success.otpWarning}
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-white px-3 py-2 text-lg font-semibold tracking-widest text-ink">
            {result.otp}
          </code>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void handleCopy();
            }}
          >
            {copied ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
            {copied
              ? ko.platform.onboard.success.copied
              : ko.platform.onboard.success.copy}
          </Button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? ko.platform.onboard.success.copied : ""}
        </span>
      </div>

      <div className="flex items-center justify-end">
        <Button type="button" onClick={onDone}>
          {ko.platform.onboard.success.done}
        </Button>
      </div>
    </Card>
  );
}
