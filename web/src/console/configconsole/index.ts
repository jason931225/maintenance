export {
  CONSOLE_VIEW_KEY,
  deployConsoleView,
  fetchConsoleViews,
  fetchOntInstances,
  fetchOntObjectTypes,
  fetchTrendSeries,
  saveConsoleView,
} from "./api";
export { DashboardEditor } from "./DashboardEditor";
export {
  computeCounts,
  computeDist,
  DASHBOARD_DOC_VERSION,
  DASHBOARD_SLOT_COUNT,
  defaultDashboardDoc,
  drillRows,
  emptyDashboardDoc,
  isDuplicateWidget,
  parseDashboardDoc,
  serializeDashboardDoc,
  setSlotWidget,
  widgetKey,
} from "./doc";
export {
  CONFIG_CONSOLE_STRINGS,
  configConsoleStrings,
  seedConfigConsoleStrings,
  type ConfigConsoleStrings,
  type ConfigConsoleStringsFilled,
} from "./strings";
export {
  CONFIG_CONSOLE_ACTIONS,
  WIDGET_KINDS,
  type ConsoleViewRecord,
  type ConsoleViewScope,
  type CountGroup,
  type CountResult,
  type CountWidget,
  type DashboardDoc,
  type DashboardSlot,
  type DeployApprovalPending,
  type DistWidget,
  type DrillFilter,
  type OntActionDef,
  type OntChoice,
  type OntInstanceRow,
  type OntObjectTypeDef,
  type OntPropertyDef,
  type TrendWidget,
  type WidgetConfig,
  type WidgetKind,
} from "./types";
export { CountCard, DistCard, TrendCard, WidgetBody, type WidgetProps } from "./widgets";
