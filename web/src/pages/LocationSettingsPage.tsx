import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { PageEmpty } from "../components/states/PageEmpty";
import { LocationConsentPanel } from "../features/location/LocationConsentPanel";
import { ko } from "../i18n/ko";

export function LocationSettingsPage() {
  const { api, session } = useAuth();
  const branchId = session?.branches?.[0];

  // The panel only uses this as a "signed-in" gate; the refresh token now lives
  // in an HttpOnly cookie and is intentionally absent from JS-visible state.
  const shimSession = session
    ? {
        access_token: session.access_token,
        token_type: "Bearer" as const,
        refresh_expires_at: "",
      }
    : undefined;

  return (
    <>
      <PageHeader title={ko.location.title} description={ko.location.subtitle} />
      <div className="max-w-2xl">
        {branchId ? (
          <LocationConsentPanel
            api={api}
            branchId={branchId}
            session={shimSession}
          />
        ) : (
          <PageEmpty message={ko.common.noBranch} />
        )}
      </div>
    </>
  );
}
