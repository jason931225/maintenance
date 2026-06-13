import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { PasskeyLoginPage } from "../features/auth/PasskeyLoginPage";

export function LoginPage() {
  const { session, api, acceptTokens } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (session) {
      // Only allow same-origin relative paths; reject protocol-relative (//evil)
      // and absolute URLs to prevent post-login open-redirect / phishing.
      const raw = searchParams.get("next");
      const next =
        raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dispatch";
      void navigate(next, { replace: true });
    }
  }, [session, navigate, searchParams]);

  const shimSession = session
    ? {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        token_type: "Bearer" as const,
        refresh_expires_at: "",
      }
    : undefined;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm grid gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-950">{ko.app.title}</h1>
        </div>
        <PasskeyLoginPage
          api={api}
          session={shimSession}
          onSessionChange={(next) => {
            acceptTokens(next ?? undefined);
          }}
        />
      </div>
    </div>
  );
}
