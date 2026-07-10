import { createTextGate } from "./lib/text-gate.mjs";

const { requireIncludes, requireNotIncludes, reportGate } = createTextGate();

requireIncludes(
  "docs/specs/cx-reporting-bi.md",
  "CX/service desk is an operational queue",
  "CX/BI spec defines service-desk queue contract",
);
requireIncludes(
  "docs/specs/cx-reporting-bi.md",
  "Scope is honest",
  "CX/BI spec prevents false group-scope BI claims",
);
requireIncludes(
  "web/src/pages/ContactPage.tsx",
  "/api/v1/storefront/inquiries",
  "contact route posts sales/CX inquiries to backend",
);
requireIncludes(
  "web/src/pages/RentalPage.tsx",
  "/contact?topic=RENTAL",
  "rental sales path routes to inquiry lifecycle",
);
requireIncludes(
  "web/src/pages/UsedSalesPage.tsx",
  "/contact?topic=USED_SALES",
  "used-sales path routes to inquiry lifecycle",
);
requireIncludes(
  "web/src/pages/SupportPage.tsx",
  "SupportCommandCenter",
  "support route has CX command center",
);
requireIncludes(
  "web/src/pages/SupportPage.tsx",
  "filterTickets",
  "support route has ticket search behavior",
);
requireIncludes(
  "web/src/pages/SupportPage.tsx",
  "buildSupportStats",
  "support route summarizes SLA/assignment/history posture",
);
requireIncludes(
  "web/src/features/support/SupportTicketDetail.tsx",
  "TicketObjectRail",
  "support ticket detail links source objects",
);
requireIncludes(
  "web/src/features/support/SupportTicketDetail.tsx",
  "/messenger?source=support&ticket=${ticketId}",
  "support ticket links messenger context",
);
requireIncludes(
  "web/src/features/support/SupportTicketDetail.tsx",
  "/mail?source=support&ticket=${ticketId}",
  "support ticket links mail context",
);
requireIncludes(
  "web/src/pages/ReportingPage.tsx",
  "ReportingCommandCenter",
  "reporting route has BI command center",
);
requireIncludes(
  "web/src/features/reporting/ReportingExport.tsx",
  "ExportHistoryList",
  "reporting export records successful session history",
);
requireIncludes(
  "web/src/console/dashboard/DashboardScreen.tsx",
  "to={stat.to}",
  "KPI dashboard links executive drilldowns",
);
requireIncludes(
  "web/src/features/kpi/WallBoard.tsx",
  "WallboardActionStrip",
  "wallboard links live execution screens",
);
requireIncludes(
  "docs/benchmarks/enterprise-ui-route-audit.json",
  "G008-import-export-hr-payroll-finance-erp",
  "enterprise route audit assigns CX/BI routes to current G008",
);
requireIncludes(
  "package.json",
  "check:cx-reporting-maturity",
  "CX/reporting maturity gate is script-wired",
);
requireIncludes(
  ".github/workflows/ci.yml",
  "npm run check:cx-reporting-maturity",
  "CI runs CX/reporting maturity gate",
);

for (const path of [
  "web/src/pages/SupportPage.tsx",
  "web/src/features/support/SupportTicketDetail.tsx",
  "web/src/pages/ReportingPage.tsx",
  "web/src/features/reporting/ReportingExport.tsx",
  "web/src/console/dashboard/DashboardScreen.tsx",
  "web/src/features/kpi/WallBoard.tsx",
]) {
  requireNotIncludes(path, "데모", `${path} has no demo copy`);
  requireNotIncludes(path, "coming soon", `${path} has no coming-soon copy`);
  requireNotIncludes(path, "아직 제공되지", `${path} has no backend-missing copy`);
}

reportGate("CX/reporting maturity gate passed");
