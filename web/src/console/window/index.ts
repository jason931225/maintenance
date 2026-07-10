export { WindowManagerProvider } from "./WindowManager";
export { WindowFrame, TrayDock, type TrayItem } from "./WindowFrame";
export {
  WindowManagerContext,
  useWindowManager,
  useOptionalWindowManager,
  usePinnedPanel,
  type WindowManagerContextValue,
} from "./windowManagerContext";
export {
  clampPanelWidth,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_DEFAULT_WIDTH,
  NARROW_BREAKPOINT,
  NARROW_PANEL_VH,
  QUADRANT_GAP,
  HEADER_BAND_MAX,
  type WindowEntry,
  type WindowState,
} from "./windowModel";
// §4-20/§4-23 object-reference drag grammar (drag source + drop target).
export {
  objDrag,
  useObjectDrop,
  parseObjectRef,
  parseObjectRefText,
  writeObjectRef,
  objectRefToken,
  OBJ_REF_MIME,
  type ObjectRef,
} from "./objDrag";
