import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import type { CustomerIntakeRequest } from "../api/types";
import { useAuth } from "../context/auth";
import {
  CustomerIntakeForm,
  type IntakeSubmitResult,
} from "../features/support/CustomerIntakeForm";
import { ko } from "../i18n/ko";

const t = ko.support.intake;

/**
 * Public, unauthenticated customer support intake (#6 KNL storefront). Routed
 * child of PublicLayout — returns only its own <main>, so the KNL dark
 * site-header and footer wrap it. The dominant storefront CTA target. Uses the
 * (token-less) API client to POST the rate-limited `/api/v1/support/intake`
 * endpoint. All copy comes from ko.support.intake.* / ko.support.form.*.
 */
export function CustomerIntakePage() {
  const { api } = useAuth();
  const [submitted, setSubmitted] = useState(false);

  async function submitIntake(
    request: CustomerIntakeRequest,
  ): Promise<IntakeSubmitResult> {
    try {
      const response = await api.POST("/api/v1/support/intake", {
        body: request,
      });
      if (response.response.status === 429) {
        return "rateLimited";
      }
      if (!response.data) {
        return "error";
      }
      setSubmitted(true);
      return "ok";
    } catch {
      return "error";
    }
  }

  return (
    <main className="flex-1 bg-muted-panel">
      <div className="mx-auto w-full max-w-[760px] px-5 py-[clamp(48px,7vw,96px)] sm:px-8">
        {/* Intro */}
        <section aria-labelledby="intake-title" className="mb-8">
          <p className="mb-3 text-[13px] font-black uppercase tracking-[0.14em] text-brand-teal">
            {t.eyebrow}
          </p>
          <h1
            id="intake-title"
            className="m-0 text-[clamp(28px,4vw,44px)] font-extrabold leading-[1.12] text-ink"
          >
            {t.title}
          </h1>
          <p className="mt-4 text-[18px] leading-[1.7] text-steel">
            {t.subtitle}
          </p>
        </section>

        <div className="rounded-xl border border-line bg-white p-6 shadow-[0_22px_70px_rgba(5,18,32,0.08)] sm:p-8">
          {submitted ? (
            <div className="grid gap-4 py-6 text-center">
              <CheckCircle2
                aria-hidden="true"
                className="mx-auto text-brand-teal"
                size={48}
              />
              <h2 className="m-0 text-2xl font-extrabold text-ink" role="status">
                {t.submitted}
              </h2>
              <p className="m-0 text-[17px] leading-[1.7] text-steel">
                {t.submittedDetail}
              </p>
              <button
                type="button"
                onClick={() => {
                  setSubmitted(false);
                }}
                className="mx-auto mt-2 inline-flex min-h-[48px] items-center justify-center rounded border border-line bg-white px-6 font-bold text-ink transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {t.another}
              </button>
            </div>
          ) : (
            <CustomerIntakeForm onSubmit={submitIntake} />
          )}
        </div>

        {/* Phone is the last resort, demoted below the online form. */}
        <p className="mt-6 text-center text-[15px] text-steel">
          {t.phoneFallbackLabel}{" "}
          <a
            href={t.phoneFallbackHref}
            className="font-bold text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {t.phoneFallback}
          </a>
        </p>
      </div>
    </main>
  );
}
