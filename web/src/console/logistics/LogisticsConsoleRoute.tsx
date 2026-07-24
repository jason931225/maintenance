import { useId, useState } from "react";

import { useAuth } from "../../context/auth";
import { logisticsStrings as text } from "../../i18n/logistics";
import { LogisticsScreen } from "./LogisticsScreen";
import { deriveLogisticsCapabilities } from "./logisticsCapabilities";
import { useLogisticsConsoleAuthz } from "./useLogisticsConsoleAuthz";
import "./logistics.css";

/**
 * Registry-mounted prop-less body: derives api/session via useAuth() and
 * selects its branch in-module from the JWT `branches` claim (the console has
 * no branch-directory read the module may call). Without a branch there is no
 * legal mutation target, so the body renders a truthful no-branch state.
 */
export function LogisticsScreenBody() {
  const { api, session } = useAuth();
  const authz = useLogisticsConsoleAuthz();
  const branches = session?.branches ?? [];
  const [chosen, setChosen] = useState<string>();
  const fallback = branches.length > 0 ? branches[0] : undefined;
  const branchId = chosen !== undefined && branches.includes(chosen) ? chosen : fallback;
  const branchSelectId = useId();

  if (branchId === undefined) {
    return (
      <section className="logistics" aria-label={text.title}>
        <div className="logistics__panel">
          <h1>{text.title}</h1>
          <p role="status">{text.noBranch}</p>
        </div>
      </section>
    );
  }

  const capabilities = deriveLogisticsCapabilities(authz, branchId);

  return (
    <div className="logistics-shell">
      {branches.length > 1 && (
        <label htmlFor={branchSelectId}>
          {text.branch}
          <select
            id={branchSelectId}
            value={branchId}
            onChange={(event) => { setChosen(event.currentTarget.value); }}
          >
            {branches.map((branch) => (
              <option key={branch} value={branch}>{branch}</option>
            ))}
          </select>
        </label>
      )}
      <LogisticsScreen
        api={api}
        branchId={branchId}
        actorId={session?.user_id}
        capabilities={capabilities}
        sessionKey={session?.client_session_incarnation ?? session?.access_token}
      />
    </div>
  );
}

/** Module-owned route adapter; shared registration stays outside this module. */
export function LogisticsConsoleRoute() {
  return <LogisticsScreenBody />;
}
