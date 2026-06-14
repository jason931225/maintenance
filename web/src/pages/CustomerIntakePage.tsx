import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import type { CustomerIntakeRequest } from "../api/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import {
  CustomerIntakeForm,
  type IntakeSubmitResult,
} from "../features/support/CustomerIntakeForm";
import { ko } from "../i18n/ko";

/**
 * Public, unauthenticated customer support intake. Mounted outside the auth
 * guard; it uses the (token-less) API client to POST the rate-limited
 * `/api/v1/support/intake` endpoint.
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
    <div className="flex min-h-screen flex-col items-center bg-slate-50 px-4 py-12">
      <div className="grid w-full max-w-xl gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-950">
            {ko.support.intake.title}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {ko.support.intake.subtitle}
          </p>
        </div>
        <Card className="grid gap-5">
          {submitted ? (
            <div className="grid gap-4 text-center">
              <CheckCircle2
                aria-hidden="true"
                className="mx-auto text-emerald-600"
                size={40}
              />
              <p role="status" className="text-base font-semibold text-slate-900">
                {ko.support.intake.submitted}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="justify-self-center"
                onClick={() => {
                  setSubmitted(false);
                }}
              >
                {ko.support.intake.another}
              </Button>
            </div>
          ) : (
            <CustomerIntakeForm onSubmit={submitIntake} />
          )}
        </Card>
      </div>
    </div>
  );
}
