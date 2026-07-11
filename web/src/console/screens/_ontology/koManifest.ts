// Wire seam for the r4 graph-canvas lane. The graph explorer + inspector copy
// this lane adds lives under ko.console.explore.graph (web/src/i18n/ko.ts — the
// single source of truth per check-ui-strings). This manifest re-exports that
// namespace so the serial wire step has one explicit surface to reconcile; the
// component reads ko directly (consistent with ObjectExplorerScreen/ObjectCard).
//
// koManifest additions (ko.console.explore.graph):
//   pane, zoomLabel, zoomIn, zoomOut, zoomReset, zoomLevel(pct),
//   legend, legendCount(count), relationAria(relation),
//   projectedNotice, projectedChip, inspectorHint
import { ko } from "../../../i18n/ko";

export const graphExplorerKoManifest = ko.console.explore.graph;
