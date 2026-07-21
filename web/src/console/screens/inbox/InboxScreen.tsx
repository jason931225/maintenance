import { useMemo } from "react";

import { useAuth } from "../../../context/auth";
import { InboxBody } from "./InboxBody";
import { createInboxApi } from "./inboxApi";

/** Shell-mounted entry (ConsoleShell nav "inbox"): binds the vault API to the
 *  authenticated console client (bearer + step-up passkey ceremony). */
export default function InboxScreen() {
  const { api } = useAuth();
  const inboxApi = useMemo(() => createInboxApi(api), [api]);
  return <InboxBody api={inboxApi} />;
}
