import { Link, useSearchParams } from "react-router-dom";

import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { AssetLifecycleCostPanel } from "../features/financial/AssetLifecycleCostPanel";
import { CostLedgerPanel } from "../features/financial/CostLedgerPanel";
import { PurchaseRequestPanel } from "../features/financial/PurchaseRequestPanel";
import { RentalQuotePanel } from "../features/financial/RentalQuotePanel";
import { ko } from "../i18n/ko";
import { isNavItemVisible } from "../components/shell/nav";

type Tab = "purchase" | "quote" | "ledger" | "assetCost";

const TABS: { key: Tab; labelKey: keyof typeof ko.financial.tabs }[] = [
  { key: "purchase", labelKey: "purchase" },
  { key: "quote", labelKey: "quote" },
  { key: "ledger", labelKey: "ledger" },
  { key: "assetCost", labelKey: "assetCost" },
];

const COMMAND_LINKS = [
  {
    href: "/approvals?source=purchase",
    labelKey: "approvals",
    navKey: "approvals",
  },
  {
    href: "/settings/workflows",
    labelKey: "workflows",
    navKey: "workflows",
  },
  { href: "/equipment", labelKey: "assets", navKey: "equipment" },
] as const;

function tabFromSearch(value: string | null): Tab {
  return TABS.some(({ key }) => key === value) ? (value as Tab) : "purchase";
}

export function FinancialPage() {
  const { api, session } = useAuth();
  const roles = session?.roles;
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromSearch(searchParams.get("tab"));

  function selectTab(nextTab: Tab) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set("tab", nextTab);
      return params;
    });
  }

  return (
    <>
      <PageHeader
        title={ko.financial.title}
        description={ko.financial.description}
      />
      <FinancialCommandCenter
        activeTab={tab}
        onSelectTab={selectTab}
        roles={session?.roles}
        groupRoles={session?.group_roles}
        featureGrants={session?.feature_grants}
      />
      <div className="mb-5 flex flex-wrap gap-2" role="tablist">
        {TABS.map(({ key, labelKey }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`min-h-10 rounded-md border px-4 py-2 text-sm font-semibold transition-colors ${
              tab === key
                ? "border-ink bg-ink text-white"
                : "border-line bg-white text-steel hover:bg-muted-panel"
            }`}
            onClick={() => {
              selectTab(key);
            }}
          >
            {ko.financial.tabs[labelKey]}
          </button>
        ))}
      </div>

      <div className="grid max-w-4xl gap-5">
        {tab === "purchase" ? (
          <PurchaseRequestPanel api={api} roles={roles} />
        ) : null}
        {tab === "quote" ? <RentalQuotePanel api={api} roles={roles} /> : null}
        {tab === "ledger" ? <CostLedgerPanel api={api} roles={roles} /> : null}
        {tab === "assetCost" ? (
          <AssetLifecycleCostPanel api={api} roles={roles} />
        ) : null}
      </div>
    </>
  );
}

function FinancialCommandCenter({
  activeTab,
  onSelectTab,
  roles,
  groupRoles,
  featureGrants,
}: {
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  roles: readonly string[] | undefined;
  groupRoles: readonly string[] | undefined;
  featureGrants: readonly string[] | undefined;
}) {
  const t = ko.financial.command;
  const commandLinks = COMMAND_LINKS.filter((link) =>
    isNavItemVisible(link.navKey, roles, groupRoles, featureGrants),
  );

  return (
    <Card className="mb-5 grid gap-4 border-ink/10 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{t.badge}</Badge>
            <span className="text-sm font-semibold text-steel">
              {t.scope}
            </span>
          </div>
          <h2 className="text-xl font-semibold text-ink">{t.title}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {commandLinks.map((link) => (
            <Button key={link.href} asChild variant="secondary">
              <Link to={link.href}>{t.links[link.labelKey]}</Link>
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {TABS.map(({ key, labelKey }) => (
          <button
            key={key}
            type="button"
            aria-pressed={activeTab === key}
            className={`rounded-lg border p-3 text-left transition-colors ${
              activeTab === key
                ? "border-ink bg-muted-panel"
                : "border-line bg-white hover:bg-muted-panel"
            }`}
            onClick={() => {
              onSelectTab(key);
            }}
          >
            <span className="block text-sm font-semibold text-ink">
              {ko.financial.tabs[labelKey]}
            </span>
            <span className="mt-1 block text-xs text-steel">
              {t.tabHints[key]}
            </span>
          </button>
        ))}
      </div>

      <dl className="grid gap-3 text-sm md:grid-cols-3">
        {t.controls.map((control) => (
          <div
            key={control.label}
            className="rounded-lg border border-line bg-muted-panel p-3"
          >
            <dt className="font-semibold text-ink">{control.label}</dt>
            <dd className="mt-1 text-steel">{control.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
