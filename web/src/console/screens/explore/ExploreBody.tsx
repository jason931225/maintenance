import { ko } from "../../../i18n/ko";
import type { ConsoleApiClient } from "../../../api/client";
import { useAuth } from "../../../context/auth";
import { OntologyWorkspaceBody } from "../_ontology/OntologyWorkspaceBody";

/**
 * 객체 탐색 (explore) screen body — the ontology graph explorer + inspector,
 * read-only (no type authoring). Clicking a node recenters the graph and pins
 * its ObjectCard as the docked inspector. Mounted by the console shell registry.
 */
export function ExploreBody({ api }: { api: ConsoleApiClient }) {
  return (
    <OntologyWorkspaceBody
      api={api}
      title={ko.console.explore.title}
      defaultTab="graph"
      allowManager={false}
    />
  );
}

/** Shell-mounted entry: pulls the org-scoped api from the auth context. */
export default function ExploreScreen() {
  const { api } = useAuth();
  return <ExploreBody api={api} />;
}
