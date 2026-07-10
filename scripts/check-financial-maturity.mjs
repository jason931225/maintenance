import { createTextGate } from "./lib/text-gate.mjs";

const { requireIncludes, requireNotIncludes, reportGate } = createTextGate();

requireIncludes(
  "web/src/pages/FinancialPage.tsx",
  "FinancialCommandCenter",
  "financial route has an operational command center",
);
requireIncludes(
  "web/src/pages/FinancialPage.tsx",
  "/approvals?source=purchase",
  "financial route links purchase work to approval center",
);
requireIncludes(
  "web/src/pages/FinancialPage.tsx",
  "/settings/workflows",
  "financial route links purchase work to workflow governance",
);
requireIncludes(
  "web/src/features/financial/PurchaseRequestPanel.tsx",
  "SourceObjectRail",
  "purchase request shows source-object rail",
);
requireIncludes(
  "web/src/features/financial/PurchaseRequestPanel.tsx",
  "PurchaseApprovalLine",
  "purchase request shows approval/payment line lifecycle",
);
requireIncludes(
  "web/src/features/financial/PurchaseRequestPanel.tsx",
  "FinanceControlBadges",
  "purchase request shows policy/audit/passkey controls",
);
requireIncludes(
  "web/src/features/financial/PurchaseRequestPanel.tsx",
  "/work-orders/${request.work_order_id}",
  "purchase request links source work order when present",
);
requireIncludes(
  "web/src/features/financial/CostLedgerPanel.tsx",
  "CostSourceLinks",
  "cost ledger links purchase/work-order source objects",
);
requireIncludes(
  "web/src/features/financial/AssetLifecycleCostPanel.tsx",
  "AssetDecisionSignal",
  "asset lifecycle cost renders deterministic review signal",
);
requireIncludes(
  "docs/specs/accounting.md",
  "not tax/accounting advice",
  "accounting spec avoids regulated-advice false claim",
);
requireIncludes(
  "docs/specs/accounting.md",
  "passkey step-up",
  "accounting spec keeps signing-equivalent passkey gate",
);
requireIncludes(
  "docs/specs/accounting.md",
  "세무사",
  "accounting spec keeps professional validation gate",
);
requireIncludes(
  "docs/benchmarks/enterprise-ui-route-audit.json",
  "G008-import-export-hr-payroll-finance-erp",
  "enterprise route audit assigns finance route to current G008",
);
requireIncludes(
  "package.json",
  "check:erp",
  "ERP domain gate remains wired",
);
requireIncludes(
  "package.json",
  "check:financial-maturity",
  "financial maturity gate is script-wired",
);
requireNotIncludes(
  "web/src/features/financial/PurchaseRequestPanel.tsx",
  "패스키 검증 완료",
  "financial UI must not falsely claim passkey enforcement",
);
requireNotIncludes(
  "web/src/pages/FinancialPage.tsx",
  "데모",
  "financial route has no demo panel copy",
);

reportGate("financial maturity gate passed");
