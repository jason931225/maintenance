import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { LocationConsentPanel } from "../features/location/LocationConsentPanel";
import { ko } from "../i18n/ko";

const defaultBranchId = "00000000-0000-4000-8000-000000000001";

export function LocationSettingsPage() {
  const { api, session } = useAuth();

  const shimSession = session
    ? {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        token_type: "Bearer" as const,
        refresh_expires_at: "",
      }
    : undefined;

  return (
    <>
      <PageHeader title={ko.location.title} description={ko.location.subtitle} />
      <div className="max-w-2xl">
        <LocationConsentPanel
          api={api}
          branchId={defaultBranchId}
          session={shimSession}
        />
      </div>
    </>
  );
}
