import { useMemo } from "react";

import { useAuth } from "../../../context/auth";
import { MyWorkBody } from "./MyWorkBody";
import { createMyWorkApi } from "./myWorkApi";

/** Shell-mounted entry (ConsoleShell nav "mywork"): binds the personal
 *  work API (action-inbox + todos) to the authenticated console client. */
export default function MyWorkScreen() {
  const { api } = useAuth();
  const myWorkApi = useMemo(() => createMyWorkApi(api), [api]);
  return <MyWorkBody api={myWorkApi} />;
}
