import type { ReactNode } from "react";

import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { makeAuthContext } from "./auth";

export function AuthTestProvider({
  children,
  value,
  session,
  overrides,
}: {
  children: ReactNode;
  value?: AuthContextValue;
  session?: AuthSession;
  overrides?: Partial<AuthContextValue>;
}) {
  return (
    <AuthContext.Provider value={value ?? makeAuthContext(session, overrides)}>
      {children}
    </AuthContext.Provider>
  );
}
