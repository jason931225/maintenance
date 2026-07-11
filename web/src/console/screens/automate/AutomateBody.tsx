// Console screen composition for the automate surface (nav 워크플로 스튜디오 —
// no single 자동화 hub owns the whole nav item, this screen IS the studio).
// §4-18: reuses the SAME AutomateHub the legacy /automate route mounts
// (AutomatePage.tsx) — rule list (활성/중지 chips + run count), the
// trigger→condition→action flow builder (console/canvas BlockCanvas, the
// canonical graph builder), 실행 이력, and the §3.9.0 version-pending banner
// (개정대기/적용승인/철회) all live in AutomateHub already, wired to the real
// workflow-studio REST. This file only supplies the console-grammar mount
// point (BulkPolicyGateProvider) — no new UI, per the composition mandate.
import { AutomateHub, AUTOMATE_GATE_ACTIONS } from "../../../pages/AutomatePage";
import { BulkPolicyGateProvider } from "../../policy";

export function AutomateBody() {
  return (
    <BulkPolicyGateProvider actions={AUTOMATE_GATE_ACTIONS}>
      <AutomateHub />
    </BulkPolicyGateProvider>
  );
}
