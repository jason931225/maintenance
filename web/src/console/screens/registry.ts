// Screen-body registry: ConsoleShell's `state.screen` key → the console-pure
// body component mounted into its screen-body slot. Keys mirror `../shell/nav.ts`'s
// `screen` values exactly. A key with no entry renders nothing (chrome-only,
// same as every screen before this wire — content lands lane by lane).
import type { ComponentType } from "react";

import { ApprovalScreenBody } from "../appr/ApprovalScreenBody";
import { AuditScreenBody } from "../audit/AuditScreenBody";
import { MailScreenBody } from "../mail";
import { MessengerScreenBody } from "../messenger";
import { AssetModuleScreen } from "../modules/AssetModuleScreen";
import { AutomateBody } from "./automate/AutomateBody";
import { DashboardBody } from "./dashboard";
import { EvidenceScreenBody } from "./evidence/EvidenceScreenBody";
import ExploreScreen from "./explore/ExploreBody";
import { ForecastBody } from "./forecast";
import InboxScreen from "./inbox/InboxScreen";
import { LaborCostBody } from "./laborcost";
import { LeaveBody } from "./leave/LeaveBody";
import { ModuleFinanceScreenBody } from "./module-finance/ModuleFinanceScreenBody";
import MyWorkScreen from "./mywork/MyWorkScreen";
import OntologyManagerScreenBody from "./ontology-manager/OntologyManagerBody";
import OverviewScreen from "./overview/OverviewScreen";
import { PolicyBody } from "./policy/PolicyBody";
import { SupportBody } from "./support/SupportBody";

export const SCREEN_REGISTRY: Readonly<Partial<Record<string, ComponentType>>> = {
  overview: OverviewScreen,
  mywork: MyWorkScreen,
  inbox: InboxScreen,
  dashboard: DashboardBody,
  laborcost: LaborCostBody,
  forecast: ForecastBody,
  finance: ModuleFinanceScreenBody,
  asset: AssetModuleScreen,
  docs: EvidenceScreenBody,
  appr: ApprovalScreenBody,
  audit: AuditScreenBody,
  leave: LeaveBody,
  policy: PolicyBody,
  // nav label "객체 탐색" — the read-only graph explorer (no type authoring).
  objectExplorer: ExploreScreen,
  // nav label "타입·매니저" — same OntologyWorkspaceBody, allowManager tab on.
  ontologyManager: OntologyManagerScreenBody,
  // AutomateHub owns rules + schedules + run history as internal tabs, so both
  // nav slots ("워크플로 스튜디오" and "예약 작업") mount the same studio.
  workflow: AutomateBody,
  scheduled: AutomateBody,
  support: SupportBody,
  messenger: MessengerScreenBody,
  mail: MailScreenBody,
};
