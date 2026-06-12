import { KeyRound, LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type { TokenPairResponse } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { ko } from "../../i18n/ko";
import {
  finishPasskeyLogin,
  logout,
  refreshToken,
  startPasskeyLogin,
} from "../../auth/webauthn";

interface PasskeyLoginPageProps {
  api: ConsoleApiClient;
  session?: TokenPairResponse;
  onSessionChange: (session?: TokenPairResponse) => void;
}

export function PasskeyLoginPage({
  api,
  session,
  onSessionChange,
}: PasskeyLoginPageProps) {
  const [userId, setUserId] = useState("");
  const [message, setMessage] = useState<string>(
    session ? ko.app.sessionReady : ko.app.sessionMissing,
  );

  async function handleLogin() {
    try {
      const ceremony = await startPasskeyLogin(api, userId.trim());
      const tokens = await finishPasskeyLogin(api, ceremony);
      onSessionChange(tokens);
      setMessage(ko.app.sessionReady);
    } catch {
      setMessage(ko.auth.loginFailed);
    }
  }

  async function handleRefresh() {
    if (!session) {
      return;
    }
    const tokens = await refreshToken(api, session.refresh_token);
    onSessionChange(tokens);
    setMessage(ko.app.sessionReady);
  }

  async function handleLogout() {
    if (session) {
      await logout(api, session.refresh_token);
    }
    onSessionChange(undefined);
    setMessage(ko.app.sessionMissing);
  }

  return (
    <Card className="grid gap-4">
      <h2 className="text-lg font-semibold text-slate-950">{ko.auth.title}</h2>
      <div className="grid gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="user-id">
          {ko.auth.userId}
        </label>
        <Input
          id="user-id"
          value={userId}
          placeholder={ko.auth.userIdPlaceholder}
          onChange={(event) => {
            setUserId(event.currentTarget.value);
          }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => {
            void handleLogin();
          }}
        >
          <KeyRound aria-hidden="true" size={18} />
          {ko.auth.login}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!session}
          onClick={() => {
            void handleRefresh();
          }}
        >
          <RefreshCw aria-hidden="true" size={18} />
          {ko.auth.refresh}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!session}
          onClick={() => {
            void handleLogout();
          }}
        >
          <LogOut aria-hidden="true" size={18} />
          {ko.auth.logout}
        </Button>
      </div>
      <p role="status" className="text-sm font-medium text-slate-700">
        {message}
      </p>
    </Card>
  );
}
