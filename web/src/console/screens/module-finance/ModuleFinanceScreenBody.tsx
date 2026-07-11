// 재무 screen — composition only. The real surface (stat strip, voucher
// ledger table with state chips, journal-entry object card, DOCUMENT FLOW chip
// chain, 승인 상신/승인/전기/반제 actions) already lives in
// GenericModuleScreen + financeModuleScreen (console/modules/*, console/finance/*);
// this body's only job is binding the real authenticated api client to it.
import { useAuth } from "../../../context/auth";
import { GenericModuleScreen } from "../../modules/GenericModuleScreen";
import { financeModuleScreen } from "../../modules/moduleScreens";

export function ModuleFinanceScreenBody() {
  const { api } = useAuth();
  return <GenericModuleScreen config={financeModuleScreen} api={api} />;
}
