import { useCallback, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  AppendManualCostLedgerRequest,
  CostLedgerEntrySummary,
} from "../../api/types";
import { hasAnyRole } from "../../components/shell/nav";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../../lib/useAutoDismiss";
import {
  COST_LEDGER_READ_ROLES,
  COST_LEDGER_WRITE_ROLES,
  DEFAULT_FINANCIAL_CONFIG,
  formatWon,
} from "./config";
import { EquipmentSelector } from "./EquipmentSelector";
import type { SelectedEquipment } from "./EquipmentSelector";

interface CostLedgerPanelProps {
  api: ConsoleApiClient;
  roles: readonly string[] | undefined;
}

type ViewState = "idle" | "loading" | "ready" | "error";

export function CostLedgerPanel({ api, roles }: CostLedgerPanelProps) {
  const canRead = hasAnyRole(roles, COST_LEDGER_READ_ROLES);
  const canWrite = hasAnyRole(roles, COST_LEDGER_WRITE_ROLES);

  const [equipment, setEquipment] = useState<SelectedEquipment>();
  const [state, setState] = useState<ViewState>("idle");
  const [entries, setEntries] = useState<CostLedgerEntrySummary[]>([]);
  const [manualAmount, setManualAmount] = useState("");
  const [manualMemo, setManualMemo] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualNotice, setManualNotice] = useState<string>();
  const [manualError, setManualError] = useState<string>();
  const clearManualNotice = useCallback(() => {
    setManualNotice(undefined);
  }, []);
  useAutoDismiss(manualNotice, clearManualNotice, SUCCESS_DISMISS_MS);

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

  async function submitManualEntry() {
    if (!equipment) return;
    const amount = Number(manualAmount.trim());
    if (!Number.isInteger(amount) || amount < 1 || !manualMemo.trim()) {
      setManualError(ko.financial.ledger.manual.invalid);
      return;
    }
    setManualSubmitting(true);
    setManualNotice(undefined);
    setManualError(undefined);
    try {
      const body: AppendManualCostLedgerRequest = {
        branch_id: equipment.branchId,
        amount_won: amount,
        memo: manualMemo.trim(),
        config: DEFAULT_FINANCIAL_CONFIG,
      };
      const response = await api.POST(
        "/api/v1/financial/equipment/{equipmentId}/cost-ledger/manual",
        { params: { path: { equipmentId: equipment.id } }, body },
      );
      if (!response.data) {
        throw new Error("manual cost ledger response missing data");
      }
      setManualNotice(ko.financial.ledger.manual.done);
      setManualAmount("");
      setManualMemo("");
      await loadLedger();
    } catch {
      setManualError(ko.financial.ledger.manual.failed);
    } finally {
      setManualSubmitting(false);
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
            setManualNotice(undefined);
            setManualError(undefined);
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

      {canWrite ? (
        <form
          className="grid gap-3 rounded-md border border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitManualEntry();
          }}
        >
          <div>
            <h3 className="text-base font-semibold text-ink">
              {ko.financial.ledger.manual.title}
            </h3>
            <p className="text-sm text-steel">
              {ko.financial.ledger.manual.description}
            </p>
          </div>
          {manualNotice ? (
            <p role="status" className="text-sm font-medium text-brand-teal">
              {manualNotice}
            </p>
          ) : null}
          {manualError ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {manualError}
            </p>
          ) : null}
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="cost-ledger-manual-amount"
            >
              {ko.financial.ledger.manual.amountLabel}
            </label>
            <Input
              id="cost-ledger-manual-amount"
              type="number"
              min={1}
              placeholder={ko.financial.ledger.manual.amountPlaceholder}
              value={manualAmount}
              onChange={(event) => {
                setManualAmount(event.currentTarget.value);
              }}
            />
          </div>
          <div className="grid gap-2">
            <label
              className="text-sm font-medium text-steel"
              htmlFor="cost-ledger-manual-memo"
            >
              {ko.financial.ledger.manual.memoLabel}
            </label>
            <Textarea
              id="cost-ledger-manual-memo"
              placeholder={ko.financial.ledger.manual.memoPlaceholder}
              rows={2}
              className="min-h-9"
              value={manualMemo}
              onChange={(event) => {
                setManualMemo(event.currentTarget.value);
              }}
            />
          </div>
          <div className="flex items-center justify-end">
            <Button
              type="submit"
              disabled={
                !equipment ||
                manualSubmitting ||
                !manualAmount.trim() ||
                !manualMemo.trim()
              }
            >
              {manualSubmitting
                ? ko.financial.ledger.manual.submitting
                : ko.financial.ledger.manual.submit}
            </Button>
          </div>
        </form>
      ) : null}

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
                    value={formatKoreanDateTime(entry.entry_at)}
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
