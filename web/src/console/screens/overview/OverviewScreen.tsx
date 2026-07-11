import { useAuth } from "../../../context/auth";
import { OverviewBody } from "./OverviewBody";

/** Shell-mounted entry: pulls the bearer token from the auth session. */
export default function OverviewScreen() {
  const { session } = useAuth();
  return <OverviewBody accessToken={session?.access_token} />;
}
