import { type CSSProperties } from "react";

import type { components } from "@maintenance/api-client-ts";
import { ModuleScreen } from "./ModuleScreen";
import { supportTicketModuleConfig, workOrderModuleConfig } from "./moduleConfigs";

/**
 * Static render of the module template's distinct visual states for the
 * fidelity rig (list / detail-open / lanes). No backend, no focus — each state
 * renders in isolation so a screenshot is reproducible. Fixture rows are passed
 * IN (the test/rig supply them from `src/test/`), keeping this app-shippable
 * with no hardcoded UI strings. `data-fidelity` selectors match
 * `module-states.mjs`. States map to the two proof configs:
 *   • list        → support config (table body)
 *   • detail-open → support config with a row's detail pre-opened
 *   • lanes       → work-order config (kanban body — its `lanes` field)
 */
export type ModuleDemoState = "list" | "detail-open" | "lanes";

type Ticket = components["schemas"]["SupportTicketSummary"];
type WorkOrder = components["schemas"]["WorkOrderListItem"];

export interface ModuleDemoProps {
  state: ModuleDemoState;
  tickets: Ticket[];
  workOrders: WorkOrder[];
}

const frameStyle: CSSProperties = {
  height: "100dvh",
  background: "var(--canvas)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

export function ModuleDemo({ state, tickets, workOrders }: ModuleDemoProps) {
  return (
    <div className="console" data-console-root style={frameStyle}>
      {state === "lanes" ? (
        <ModuleScreen config={workOrderModuleConfig} rows={workOrders} loadState="idle" />
      ) : (
        <ModuleScreen
          config={supportTicketModuleConfig}
          rows={tickets}
          loadState="idle"
          initialOpenId={state === "detail-open" ? tickets[0]?.id : undefined}
        />
      )}
    </div>
  );
}
