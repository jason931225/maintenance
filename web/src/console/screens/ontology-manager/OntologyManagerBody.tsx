import { ko } from "../../../i18n/ko";
import type { ConsoleApiClient } from "../../../api/client";
import { useAuth } from "../../../context/auth";
import { OntologyWorkspaceBody } from "../_ontology/OntologyWorkspaceBody";
import { ontologyRevisionAuthorityKey } from "../../ontology/useOntologyRevisionCommitQueue";

/**
 * 온톨로지 (ontology manager) screen body — the same graph explorer + inspector
 * as 객체 탐색, plus the 타입·매니저 authoring tab (draft/publish object types,
 * stage v+1 revisions). Mounted by the console shell registry.
 */
export function OntologyManagerBody({
  api,
  authorityKey,
}: {
  api: ConsoleApiClient;
  authorityKey: string;
}) {
  return (
    <OntologyWorkspaceBody
      api={api}
      authorityKey={authorityKey}
      title={ko.nav.ontology}
      defaultTab="manager"
      allowManager
    />
  );
}

/** Shell-mounted entry: pulls the org-scoped api from the auth context. */
export default function OntologyManagerScreenBody() {
  const { api, session, viewAs } = useAuth();
  return (
    <OntologyManagerBody
      api={api}
      authorityKey={ontologyRevisionAuthorityKey(session, viewAs)}
    />
  );
}
