import { useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type { CostLedgerEntrySummary } from "../../api/types";
import { hasAnyRole } from "../../components/shell/nav";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { COST_LEDGER_READ_ROLES, formatWon } from "./config";
import { EquipmentSelector } from "./EquipmentSelector";
import type { SelectedEquipment } from "./EquipmentSelector";

interface CostLedgerPanelProps {
  api: ConsoleApiClient;
  roles: readonly string[] | undefined;
}

type ViewState = "idle" | "loading" | "ready" | "error";

export function CostLedgerPanel({ api, roles }: CostLedgerPanelProps) {
  const canRead = hasAnyRole(roles, COST_LEDGER_READ_ROLES);

  const [equipment, setEquipment] = useState<SelectedEquipment>();
  const [state, setState] = useState<ViewState>("idle");
  const [entries, setEntries] = useState<CostLedgerEntrySummary[]>([]);

  async function loadLedger() {
    if (!equipment) return;
    setState("loading");
    try {
      const response = await api.GET(
        "/api/v1/financial/equipment/{equipmentId}/cost-ledger",
        { params: { path: { equipmentId: equipment.id } } },
      );
      if (!response.data) {
        throw new Error("cost ledger response missing data");
      }
      setEntries(response.data);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  if (!canRead) {
    return (
      <Card className="grid gap-2">
        <h2 className="text-lg font-semibold text-ink">
          {ko.financial.ledger.title}
        </h2>
        <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
          {ko.financial.ledger.empty}
        </p>
      </Card>
    );
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">
          {ko.financial.ledger.title}
        </h2>
        <p className="text-sm text-steel">
          {ko.financial.ledger.description}
        </p>
      </div>

      <div className="grid gap-3 rounded-md border border-line p-4">
        <EquipmentSelector
          api={api}
          selected={equipment}
          onSelect={(next) => {
            setEquipment(next);
            setState("idle");
            setEntries([]);
          }}
        />
        <div className="flex items-center justify-end">
          <Button
            type="button"
            disabled={!equipment || state === "loading"}
            onClick={() => {
              void loadLedger();
            }}
          >
            {state === "loading"
              ? ko.financial.ledger.loading
              : ko.financial.ledger.view}
          </Button>
        </div>
      </div>

      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.financial.ledger.failed}
        </p>
      ) : null}

      {state === "ready" ? (
        entries.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.financial.ledger.empty}
          </p>
        ) : (
          <ul className="grid gap-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-2 rounded-md border border-line p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-ink">
                    {formatWon(entry.amount_won)} {ko.financial.wonUnit}
                  </span>
                  <Badge>{ko.financial.ledger.sources[entry.source]}</Badge>
                </div>
                {entry.memo ? (
                  <p className="text-sm text-steel">{entry.memo}</p>
                ) : null}
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <Row
                    label={ko.financial.ledger.residualBefore}
                    value={`${formatWon(entry.residual_before_won)} ${ko.financial.wonUnit}`}
                  />
                  <Row
                    label={ko.financial.ledger.residualAfter}
                    value={`${formatWon(entry.residual_after_won)} ${ko.financial.wonUnit}`}
                  />
                  <Row
                    label={ko.financial.ledger.entryAt}
                    value={entry.entry_at}
                  />
                </dl>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-steel">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
