import { useCallback, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  CreateRentalQuoteRequest,
  RentalQuoteSummary,
} from "../../api/types";
import { hasAnyRole } from "../../components/shell/nav";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { ko } from "../../i18n/ko";
import { SUCCESS_DISMISS_MS, useAutoDismiss } from "../../lib/useAutoDismiss";
import { DEFAULT_FINANCIAL_CONFIG, formatWon, RENTAL_QUOTE_ROLES } from "./config";
import { EquipmentSelector } from "./EquipmentSelector";
import type { SelectedEquipment } from "./EquipmentSelector";

interface RentalQuotePanelProps {
  api: ConsoleApiClient;
  roles: readonly string[] | undefined;
}

type WriteState = "idle" | "saving" | "error";

function upsert(
  list: RentalQuoteSummary[],
  next: RentalQuoteSummary,
): RentalQuoteSummary[] {
  return [next, ...list.filter((item) => item.id !== next.id)];
}

export function RentalQuotePanel({ api, roles }: RentalQuotePanelProps) {
  const canManage = hasAnyRole(roles, RENTAL_QUOTE_ROLES);

  const [quotes, setQuotes] = useState<RentalQuoteSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = quotes.find((item) => item.id === selectedId);

  const [equipment, setEquipment] = useState<SelectedEquipment>();
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [notice, setNotice] = useState<string>();
  const clearNotice = useCallback(() => {
    setNotice(undefined);
  }, []);
  useAutoDismiss(notice, clearNotice, SUCCESS_DISMISS_MS);

  const [lookupId, setLookupId] = useState("");
  const [lookupError, setLookupError] = useState(false);

  async function handleCreate() {
    if (!equipment) return;
    setWriteState("saving");
    setNotice(undefined);
    try {
      const body: CreateRentalQuoteRequest = {
        branch_id: equipment.branchId,
        equipment_id: equipment.id,
        config: DEFAULT_FINANCIAL_CONFIG,
      };
      const response = await api.POST("/api/v1/financial/rental-quotes", {
        body,
      });
      if (!response.data) {
        throw new Error("create rental quote response missing data");
      }
      setQuotes((prev) => upsert(prev, response.data));
      setSelectedId(response.data.id);
      setNotice(ko.financial.quote.createSuccess);
      setWriteState("idle");
    } catch {
      setWriteState("error");
    }
  }

  async function handleLookup() {
    const id = lookupId.trim();
    if (!id) return;
    setLookupError(false);
    try {
      const response = await api.GET(
        "/api/v1/financial/rental-quotes/{quoteId}",
        { params: { path: { quoteId: id } } },
      );
      if (!response.data) {
        throw new Error("rental quote not found");
      }
      setQuotes((prev) => upsert(prev, response.data));
      setSelectedId(response.data.id);
      setLookupId("");
    } catch {
      setLookupError(true);
    }
  }

  if (!canManage) {
    return (
      <Card className="grid gap-2">
        <h2 className="text-lg font-semibold text-ink">
          {ko.financial.quote.listTitle}
        </h2>
        <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
          {ko.financial.quote.empty}
        </p>
      </Card>
    );
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">
          {ko.financial.quote.listTitle}
        </h2>
        <p className="text-sm text-steel">
          {ko.financial.quote.listDescription}
        </p>
      </div>

      {notice ? (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {notice}
        </p>
      ) : null}

      <form
        className="grid gap-3 rounded-md border border-line p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <EquipmentSelector
          api={api}
          selected={equipment}
          onSelect={setEquipment}
        />
        {writeState === "error" ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.financial.quote.createFailed}
          </p>
        ) : null}
        <div className="flex items-center justify-end">
          <Button
            type="submit"
            disabled={writeState === "saving" || !equipment}
          >
            {writeState === "saving"
              ? ko.financial.quote.creating
              : ko.financial.quote.create}
          </Button>
        </div>
      </form>

      <div className="grid gap-2 rounded-md border border-line p-3">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="quote-lookup"
        >
          {ko.financial.quote.lookupLabel}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="quote-lookup"
            value={lookupId}
            placeholder={ko.financial.quote.lookupPlaceholder}
            onChange={(event) => {
              setLookupId(event.currentTarget.value);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={lookupId.trim().length === 0}
            onClick={() => {
              void handleLookup();
            }}
          >
            {ko.financial.quote.lookup}
          </Button>
        </div>
        {lookupError ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {ko.financial.quote.lookupFailed}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        {quotes.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.financial.quote.empty}
          </p>
        ) : (
          quotes.map((quote) => (
            <button
              key={quote.id}
              type="button"
              aria-pressed={quote.id === selectedId}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-left ${
                quote.id === selectedId
                  ? "border-ink bg-muted-panel"
                  : "border-line hover:bg-muted-panel"
              }`}
              onClick={() => {
                setSelectedId(quote.id);
              }}
            >
              <span className="text-sm text-steel">
                {ko.financial.quote.createdAt}{" "}
                {new Date(quote.created_at).toLocaleString("ko-KR", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              <span className="font-semibold text-ink">
                {formatWon(quote.monthly_total)} {ko.financial.wonUnit}
              </span>
            </button>
          ))
        )}
      </div>

      {selected ? (
        <div className="grid gap-3 rounded-md border border-line bg-muted-panel p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-ink">
              {ko.financial.quote.monthlyTotal}
            </h3>
            <span className="text-lg font-semibold text-ink">
              {formatWon(selected.monthly_total)} {ko.financial.wonUnit}
            </span>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row
              label={ko.financial.quote.acquisitionValue}
              value={`${formatWon(selected.acquisition_value)} ${ko.financial.wonUnit}`}
            />
            <Row
              label={ko.financial.quote.residualValue}
              value={`${formatWon(selected.effective_residual_value)} ${ko.financial.wonUnit}${
                selected.residual_was_floored
                  ? ` (${ko.financial.quote.residualFloored})`
                  : ""
              }`}
            />
            <Row
              label={ko.financial.quote.cumulativeRepairCost}
              value={`${formatWon(selected.cumulative_repair_cost)} ${ko.financial.wonUnit}`}
            />
          </dl>
          <div className="grid gap-1">
            <h4 className="text-sm font-semibold text-steel">
              {ko.financial.quote.lines}
            </h4>
            <ul className="grid gap-1">
              {selected.lines.map((line) => (
                <li
                  key={line.code}
                  className="flex items-center justify-between rounded-md border border-line bg-white px-3 py-2 text-sm"
                >
                  <span className="text-steel">{line.label}</span>
                  <span className="font-semibold text-ink">
                    {formatWon(line.amount)} {ko.financial.wonUnit}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
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
