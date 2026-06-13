import React, { createContext, useContext, useMemo, useState } from "react";

import { createConsoleApiClient } from "../api/client";
import type { ConsoleApiClient } from "../api/client";
import {
  finishPasskeyLogin,
  logout as logoutWebAuthn,
  refreshToken as refreshTokenFn,
  startPasskeyLogin,
} from "../auth/webauthn";

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  role?: "technician" | "admin" | "executive" | "super-admin";
  user_id?: string;
}

export interface AuthContextValue {
  session: AuthSession | undefined;
  login: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Accept a token pair obtained externally (e.g. via PasskeyLoginPage). */
  acceptTokens: (tokens: { access_token: string; refresh_token: string } | undefined) => void;
  api: ConsoleApiClient;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

const STORAGE_KEY = "maintenance_console_session";

function loadSessionFromStorage(): AuthSession | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : undefined;
  } catch {
    return undefined;
  }
}

function saveSessionToStorage(s: AuthSession) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function clearSessionFromStorage() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Session hydrates synchronously from sessionStorage, so there is no async
  // loading phase to guard against.
  const [session, setSession] = useState<AuthSession | undefined>(
    () => loadSessionFromStorage(),
  );

  const api = useMemo(
    () => createConsoleApiClient(session?.access_token),
    [session?.access_token],
  );

  async function login(userId: string) {
    const ceremony = await startPasskeyLogin(api, userId.trim());
    const tokens = await finishPasskeyLogin(api, ceremony);
    const next: AuthSession = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    };
    setSession(next);
    saveSessionToStorage(next);
  }

  async function logout() {
    if (session) {
      await logoutWebAuthn(api, session.refresh_token).catch(() => {});
    }
    setSession(undefined);
    clearSessionFromStorage();
  }

  async function refresh() {
    if (!session) return;
    const tokens = await refreshTokenFn(api, session.refresh_token);
    const next: AuthSession = { ...session, ...tokens };
    setSession(next);
    saveSessionToStorage(next);
  }

  function acceptTokens(tokens: { access_token: string; refresh_token: string } | undefined) {
    if (!tokens) {
      setSession(undefined);
      clearSessionFromStorage();
      return;
    }
    const next: AuthSession = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    };
    setSession(next);
    saveSessionToStorage(next);
  }

  return (
    <AuthContext.Provider value={{ session, login, logout, refresh, acceptTokens, api }}>
      {children}
    </AuthContext.Provider>
  );
}
