import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { MessengerPanel } from "../features/messenger/MessengerPanel";
import { ko } from "../i18n/ko";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? (typeof window !== "undefined" ? window.location.origin : "");

export function MessengerPage() {
  const { api, session } = useAuth();

  return (
    <>
      <PageHeader title={ko.messenger.title} description={ko.messenger.description} />
      <MessengerPanel
        api={api}
        accessToken={session?.access_token}
        apiBaseUrl={apiBaseUrl}
      />
    </>
  );
}
