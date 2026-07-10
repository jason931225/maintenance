export { fetchOntInstances, fetchOntObjectTypes } from "./api";
export { DashboardEditor } from "./DashboardEditor";
export {
  computeCounts,
  DASHBOARD_DOC_VERSION,
  DASHBOARD_SLOT_COUNT,
  defaultDashboardDoc,
  drillRows,
  emptyDashboardDoc,
  parseDashboardDoc,
  serializeDashboardDoc,
  setSlotWidget,
} from "./doc";
export { CONFIG_CONSOLE_STRINGS, seedConfigConsoleStrings, type ConfigConsoleStrings } from "./strings";
export {
  CONFIG_CONSOLE_ACTIONS,
  WIDGET_KINDS,
  type ChartWidget,
  type CountGroup,
  type CountResult,
  type DashboardDoc,
  type DashboardSlot,
  type DrillFilter,
  type LiveCountWidget,
  type OntActionDef,
  type OntChoice,
  type OntInstanceRow,
  type OntObjectTypeDef,
  type OntPropertyDef,
  type StatBarWidget,
  type WidgetConfig,
  type WidgetKind,
} from "./types";
export { BarChartCard, LiveCountCard, StatBarCard, WidgetBody, type WidgetProps } from "./widgets";
