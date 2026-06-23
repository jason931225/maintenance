import { useState } from "react";

import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { AssetLifecycleCostPanel } from "../features/financial/AssetLifecycleCostPanel";
import { CostLedgerPanel } from "../features/financial/CostLedgerPanel";
import { PurchaseRequestPanel } from "../features/financial/PurchaseRequestPanel";
import { RentalQuotePanel } from "../features/financial/RentalQuotePanel";
import { ko } from "../i18n/ko";

type Tab = "purchase" | "quote" | "ledger" | "assetCost";

const TABS: { key: Tab; labelKey: keyof typeof ko.financial.tabs }[] = [
  { key: "purchase", labelKey: "purchase" },
  { key: "quote", labelKey: "quote" },
  { key: "ledger", labelKey: "ledger" },
  { key: "assetCost", labelKey: "assetCost" },
];

export function FinancialPage() {
  const { api, session } = useAuth();
  const roles = session?.roles;
  const [tab, setTab] = useState<Tab>("purchase");

  return (
    <>
      <PageHeader
        title={ko.financial.title}
        description={ko.financial.description}
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
                ? "border-slate-950 bg-slate-950 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
            onClick={() => {
              setTab(key);
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
