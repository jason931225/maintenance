import { useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type { AssetLifecycleCostSummary } from "../../api/types";
import { hasAnyRole } from "../../components/shell/nav";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { COST_LEDGER_READ_ROLES, formatWon } from "./config";
import { EquipmentSelector } from "./EquipmentSelector";
import type { SelectedEquipment } from "./EquipmentSelector";

interface AssetLifecycleCostPanelProps {
  api: ConsoleApiClient;
  roles: readonly string[] | undefined;
}

type ViewState = "idle" | "loading" | "ready" | "error";

const t = ko.financial.assetCost;

export function AssetLifecycleCostPanel({
  api,
  roles,
}: AssetLifecycleCostPanelProps) {
  const canRead = hasAnyRole(roles, COST_LEDGER_READ_ROLES);

  const [equipment, setEquipment] = useState<SelectedEquipment>();
  const [state, setState] = useState<ViewState>("idle");
  const [summary, setSummary] = useState<AssetLifecycleCostSummary>();

  async function loadSummary() {
    if (!equipment) return;
    setState("loading");
    try {
      const response = await api.GET(
        "/api/v1/financial/equipment/{equipmentId}/lifecycle-cost",
        { params: { path: { equipmentId: equipment.id } } },
      );
      if (!response.data) {
        throw new Error("lifecycle cost response missing data");
      }
      setSummary(response.data);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  if (!canRead) {
    return (
      <Card className="grid gap-2">
        <h2 className="text-lg font-semibold text-slate-950">{t.title}</h2>
        <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          {t.empty}
        </p>
      </Card>
    );
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">{t.title}</h2>
        <p className="text-sm text-slate-600">{t.description}</p>
      </div>

      <div className="grid gap-3 rounded-md border border-slate-200 p-4">
        <EquipmentSelector
          api={api}
          selected={equipment}
          onSelect={(next) => {
            setEquipment(next);
            setState("idle");
            setSummary(undefined);
          }}
        />
        <div className="flex items-center justify-end">
          <Button
            type="button"
            disabled={!equipment || state === "loading"}
            onClick={() => {
              void loadSummary();
            }}
          >
            {state === "loading" ? t.loading : t.view}
          </Button>
        </div>
      </div>

      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {t.failed}
        </p>
      ) : null}

      {state === "ready" && summary ? (
        <LifecycleSummary summary={summary} />
      ) : null}
    </Card>
  );
}

function LifecycleSummary({
  summary,
}: {
  summary: AssetLifecycleCostSummary;
}) {
  const isSold = summary.sale_price_won != null;
  const fallback =
    summary.acquisition_source === "VEHICLE_VALUE_FALLBACK";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-slate-950">
          {summary.equipment_no}
        </span>
        <Badge>{summary.status}</Badge>
      </div>

      {fallback ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
          {t.acquisitionFallbackNote}
        </p>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2">
        <Money
          label={t.acquisitionCost}
          amount={summary.acquisition_cost_won}
          note={summary.acquisition_date ?? undefined}
        />
        <Money label={t.maintenanceTotal} amount={summary.maintenance_total_won} />
        <Money label={t.maintenanceManual} amount={summary.manual_total_won} />
        <Money
          label={t.maintenancePurchase}
          amount={summary.purchase_total_won}
        />
        <Money
          label={t.outsourceUnlinked}
          amount={summary.outsource_unlinked_won}
        />
        <Money label={t.residualValue} amount={summary.residual_value_won} />
        {isSold ? (
          <Money
            label={t.salePrice}
            amount={summary.sale_price_won}
            note={summary.sold_at ?? undefined}
          />
        ) : null}
        {isSold ? (
          <Money label={t.grossMargin} amount={summary.gross_margin_won} />
        ) : null}
        <Money label={t.tco} amount={summary.tco_won} emphasize />
        <Money label={t.costPerMonth} amount={summary.cost_per_month_won} />
        <Money label={t.costPerHour} amount={summary.cost_per_hour_won} />
      </dl>

      {summary.timeline.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="text-base font-semibold text-slate-950">
            {t.timelineTitle}
          </h3>
          <ul className="grid gap-2">
            {summary.timeline.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 p-3"
              >
                <span className="font-semibold text-slate-950">
                  {formatWon(entry.amount_won)} {ko.financial.wonUnit}
                </span>
                <div className="flex items-center gap-2">
                  <Badge>{t.sources[entry.source]}</Badge>
                  <span className="text-sm text-slate-600">
                    {entry.entry_at}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Money({
  label,
  amount,
  note,
  emphasize,
}: {
  label: string;
  amount: number | null | undefined;
  note?: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <dt className="text-sm font-semibold text-slate-600">{label}</dt>
      <dd
        className={
          emphasize
            ? "text-lg font-bold text-slate-950"
            : "text-slate-950"
        }
      >
        {amount == null
          ? t.notAvailable
          : `${formatWon(amount)} ${ko.financial.wonUnit}`}
      </dd>
      {note ? <dd className="text-sm text-slate-500">{note}</dd> : null}
    </div>
  );
}
