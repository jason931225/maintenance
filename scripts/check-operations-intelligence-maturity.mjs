import { createTextGate } from "./lib/text-gate.mjs";

const { requireIncludes, requireNotIncludes, reportGate } = createTextGate();

requireIncludes(
  "docs/specs/operations-intelligence.md",
  "Recommendation, not silent automation",
  "operations intelligence spec forbids silent automation",
);
requireIncludes(
  "docs/specs/operations-intelligence.md",
  "Mechanical and algorithmic foundations first",
  "operations intelligence spec requires deterministic foundations first",
);
requireIncludes(
  "docs/specs/operations-intelligence.md",
  "First shipped deterministic UI foundation (G012)",
  "operations intelligence spec records shipped G012 slice",
);
requireIncludes(
  "docs/specs/operations-intelligence.md",
  "Scenario write-back creates a workflow draft/request",
  "operations intelligence spec routes write-back through workflow drafts",
);
requireIncludes(
  "docs/specs/operations-intelligence.md",
  "AI, ML, RL, and advanced analytics are only useful if the platform already measures the business",
  "operations intelligence spec keeps observability before AI",
);
requireIncludes(
  "docs/specs/mes.md",
  "long-term enterprise operations platform",
  "MES spec keeps MES future-scoped",
);
requireIncludes(
  "docs/specs/mes.md",
  "Do not implement MES screens before group/org",
  "MES spec blocks isolated premature MES screens",
);
requireIncludes(
  "docs/specs/mes.md",
  "Do not use AI/ML/RL for scheduling",
  "MES spec blocks premature AI scheduling",
);
requireIncludes(
  "web/src/pages/OperationsIntelligencePage.tsx",
  "OperationsIntelligenceCommandCenter",
  "operations intelligence page has a command center",
);
requireIncludes(
  "web/src/pages/OperationsIntelligencePage.tsx",
  "ScenarioReadinessMatrix",
  "operations intelligence page has readiness matrix",
);
requireIncludes(
  "web/src/pages/OperationsIntelligencePage.tsx",
  "DecisionDomainCards",
  "operations intelligence page has decision domain cards",
);
requireIncludes(
  "web/src/pages/OperationsIntelligencePage.tsx",
  "GovernanceGateRail",
  "operations intelligence page has governance rail",
);
requireIncludes(
  "web/src/pages/OperationsIntelligencePage.tsx",
  "commandActionNavKeys",
  "operations intelligence command links are tied to nav authorization",
);
requireIncludes(
  "web/src/pages/OperationsIntelligencePage.tsx",
  "/approvals?source=intelligence&domain=rental-pricing",
  "pricing scenario converts to approval workflow route",
);
requireIncludes(
  "web/src/pages/FinancialPage.tsx",
  "useSearchParams",
  "financial workbench honors operations-intelligence deep-link tab hints",
);
requireIncludes(
  "web/src/pages/FinancialPage.tsx",
  "COMMAND_LINKS",
  "financial command links are tied to nav authorization",
);
requireIncludes(
  "web/src/pages/FinancialPage.test.tsx",
  "opens the tab requested by a deep link",
  "financial deep-link regression covers scenario handoff",
);
requireIncludes(
  "web/src/pages/FinancialPage.test.tsx",
  "hides command links that the current role cannot open",
  "financial command links have role-alignment regression coverage",
);
requireIncludes(
  "web/src/AppRouter.tsx",
  "path=\"/intelligence\"",
  "AppRouter exposes /intelligence route",
);
requireIncludes(
  "web/src/AppRouter.tsx",
  "OperationsIntelligencePage",
  "AppRouter lazy-loads operations intelligence page",
);
requireIncludes(
  "web/src/components/shell/nav.ts",
  "key: \"intelligence\"",
  "nav exposes operations intelligence item",
);
requireIncludes(
  "web/src/components/shell/nav.ts",
  "[\"intelligence\", KPI_ROLES]",
  "nav gates intelligence to KPI roles",
);
requireIncludes(
  "web/src/components/shell/nav.ts",
  "[\"intelligence\", [FEATURES.KPI_READ]]",
  "nav allows custom KPI_READ grants for intelligence",
);
requireIncludes(
  "web/src/pages/OperationsIntelligencePage.test.tsx",
  "not.toBeInTheDocument",
  "operations intelligence test guards against autonomous/demo copy",
);
requireIncludes(
  "docs/benchmarks/enterprise-ui-route-audit.json",
  "\"/intelligence\"",
  "enterprise route audit covers /intelligence",
);
requireIncludes(
  "docs/benchmarks/enterprise-ui-route-audit.json",
  "G008-import-export-hr-payroll-finance-erp",
  "enterprise route audit assigns current G008 ownership",
);
requireIncludes(
  "docs/benchmarks/enterprise-ui-route-audit.json",
  "AI/MES/optimization stay recommendation/scenario and future-scope only",
  "enterprise route audit preserves AI/MES guardrail",
);
requireIncludes(
  "docs/benchmarks/enterprise-ui-route-audit.json",
  "Story-coverage personas only, not authorization",
  "enterprise route audit separates persona coverage from authorization gates",
);
requireIncludes(
  "package.json",
  "check:operations-intelligence-maturity",
  "operations intelligence maturity gate is script-wired",
);
requireIncludes(
  ".github/workflows/ci.yml",
  "npm run check:operations-intelligence-maturity",
  "CI runs operations intelligence maturity gate",
);

for (const path of [
  "web/src/pages/OperationsIntelligencePage.tsx",
  "web/src/i18n/ko.ts",
]) {
  requireNotIncludes(path, "coming soon", `${path} has no coming-soon copy`);
  requireNotIncludes(path, "Coming soon", `${path} has no coming-soon copy`);
  requireNotIncludes(path, "데모", `${path} has no demo copy`);
  requireNotIncludes(path, "자동 실행", `${path} does not claim autonomous execution`);
  requireNotIncludes(path, "직접 변경합니다", `${path} does not claim direct mutation`);
}

reportGate("operations intelligence maturity gate passed");
