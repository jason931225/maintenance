import { useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ko } from "../../i18n/ko";

/** A resolved equipment row: the financial endpoints key off these UUIDs. */
export interface SelectedEquipment {
  id: string;
  branchId: string;
  managementNo: string;
  model: string;
  customerName: string;
}

interface EquipmentSelectorProps {
  api: ConsoleApiClient;
  selected: SelectedEquipment | undefined;
  onSelect: (equipment: SelectedEquipment) => void;
}

type LookupState = "idle" | "loading" | "notFound" | "error";

/**
 * Resolves an equipment management number to an equipment id/branch via the
 * existing lookup endpoint. The financial create flows need the equipment UUID
 * and its branch, which the lookup response carries directly.
 */
export function EquipmentSelector({
  api,
  selected,
  onSelect,
}: EquipmentSelectorProps) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LookupState>("idle");

  async function runLookup() {
    const managementNo = query.trim();
    if (!managementNo) return;
    setState("loading");
    try {
      const response = await api.GET("/api/v1/equipment/lookup", {
        params: { query: { management_no: managementNo } },
      });
      if (response.data) {
        const eq = response.data;
        onSelect({
          id: eq.id,
          branchId: eq.branch_id,
          managementNo: eq.management_no ?? eq.equipment_no,
          model: eq.model ?? ko.common.unknown,
          customerName: eq.customer.name,
        });
        setState("idle");
        return;
      }
      setState("notFound");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="grid gap-2">
      <label
        className="text-sm font-medium text-steel"
        htmlFor="financial-equipment-lookup"
      >
        {ko.financial.equipmentLookup.label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="financial-equipment-lookup"
          value={query}
          placeholder={ko.financial.equipmentLookup.placeholder}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void runLookup();
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={state === "loading" || query.trim().length === 0}
          onClick={() => {
            void runLookup();
          }}
        >
          {state === "loading"
            ? ko.financial.equipmentLookup.searching
            : ko.financial.equipmentLookup.label}
        </Button>
      </div>
      {state === "notFound" ? (
        <p
          aria-live="assertive"
          className="rounded-md border border-dashed border-red-300 bg-red-50 p-2 text-sm font-medium text-red-800"
        >
          {ko.financial.equipmentLookup.notFound}
        </p>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {ko.financial.equipmentLookup.failed}
        </p>
      ) : null}
      {selected ? (
        <dl className="grid gap-1 rounded-md border border-line bg-muted-panel p-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-semibold text-steel">
              {ko.financial.equipmentLookup.selected}
            </dt>
            <dd className="text-ink">{selected.managementNo}</dd>
          </div>
          <div>
            <dt className="font-semibold text-steel">{ko.intake.model}</dt>
            <dd className="text-ink">{selected.model}</dd>
          </div>
          <div>
            <dt className="font-semibold text-steel">
              {ko.intake.customer}
            </dt>
            <dd className="text-ink">{selected.customerName}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
