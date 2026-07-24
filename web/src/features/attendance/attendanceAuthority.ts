import type { AuthSession } from "../../context/auth";

/**
 * Identifies one effective attendance authority.
 *
 * A client session incarnation survives a proven token refresh, while the
 * refreshed token may reduce grants or branch scope. Both values therefore
 * own private attendance state and in-flight authorization reads.
 */
export function attendanceAuthorityKey(
  session:
    | Pick<AuthSession, "access_token" | "client_session_incarnation">
    | undefined,
): string | undefined {
  if (!session) return undefined;
  return JSON.stringify([
    session.client_session_incarnation ?? null,
    session.access_token,
  ]);
}
