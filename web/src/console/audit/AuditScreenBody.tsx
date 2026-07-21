// 감사 로그 screen body — the SCREEN_REGISTRY mount for the "audit" nav slot.
// AuditFeed already reads the real, RLS-scoped audit stream (GET /api/audit,
// AUDIT_ROUTE_PATH) and owns its own loading/error/empty states; this body only
// binds the authenticated bearer token from the session so the feed can
// authorize. Prop-less by SCREEN_REGISTRY contract (ConsoleShell mounts bodies
// with no props), same idiom as ModuleFinanceScreenBody.
import { useAuth } from "../../context/auth";
import { AuditFeed } from "./AuditFeed";

export function AuditScreenBody() {
  const { session } = useAuth();
  return <AuditFeed bearerToken={session?.access_token} />;
}
