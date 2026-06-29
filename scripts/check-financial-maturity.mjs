import { readFileSync } from "node:fs";

const checks = [];

function read(path) {
  return readFileSync(path, "utf8");
}

function requireIncludes(path, needle, label) {
  const text = read(path);
  if (!text.includes(needle)) {
    throw new Error(`${label}: expected ${path} to include ${JSON.stringify(needle)}`);
  }
  checks.push(label);
}

function requireNotIncludes(path, needle, label) {
  const text = read(path);
  if (text.includes(needle)) {
    throw new Error(`${label}: ${path} must not include ${JSON.stringify(needle)}`);
  }
  checks.push(label);
}

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
  "G025-finance-procurement-accounting-and-a",
  "enterprise route audit assigns finance route to G025",
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

console.log(`financial maturity gate passed (${checks.length} checks)`);
