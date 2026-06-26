import { PageHeader } from "../components/shell/PageHeader";
import { SecurityPanel } from "../features/auth/SecurityPanel";
import { ko } from "../i18n/ko";

/**
 * Platform-account self-service security. Kept separate from the tenant profile
 * page because platform JWTs are intentionally rejected by tenant-scoped
 * `/api/v1/users/me` and `/api/v1/passkeys` middleware.
 */
export function PlatformAccountPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <PageHeader
        title={ko.platform.account.title}
        description={ko.platform.account.description}
      />
      <SecurityPanel />
    </div>
  );
}
