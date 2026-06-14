import { useEffect, useState } from "react";

import type { EquipmentLookupResponse, EquipmentLookupState } from "../api/types";
import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { PageError } from "../components/states/PageError";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { ko } from "../i18n/ko";

const equipmentDebounceMs = 300;

export function EquipmentPage() {
  const { api } = useAuth();
  const [managementNo, setManagementNo] = useState("");
  const [suggestions, setSuggestions] = useState<EquipmentLookupResponse[]>([]);
  const [lookupState, setLookupState] = useState<EquipmentLookupState>({ status: "idle" });

  useEffect(() => {
    const query = managementNo.trim();
    let ignore = false;

    if (!query) {
      return undefined;
    }

    async function load() {
      const [autocompleteResponse, lookupResponse] = await Promise.all([
        api.GET("/api/v1/equipment", {
          params: { query: { q: query, limit: 5 } },
        }),
        api.GET("/api/v1/equipment/lookup", {
          params: { query: { management_no: query } },
        }),
      ]);

      if (ignore) return;

      setSuggestions(autocompleteResponse.data?.items ?? []);
      if (lookupResponse.data) {
        const eq = lookupResponse.data;
        setLookupState({
          status: "ready",
          equipment: {
            managementNo: eq.management_no ?? eq.equipment_no,
            model: eq.model ?? ko.common.unknown,
            customerName: eq.customer.name,
            siteName: eq.site.name,
          },
        });
        return;
      }
      setLookupState({ status: "notFound" });
    }

    const timer = window.setTimeout(() => {
      load().catch(() => {
        if (!ignore) {
          setSuggestions([]);
          setLookupState({ status: "error" });
        }
      });
    }, equipmentDebounceMs);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [api, managementNo]);

  function handleChange(value: string) {
    setManagementNo(value);
    if (value.trim().length === 0) {
      setSuggestions([]);
      setLookupState({ status: "idle" });
      return;
    }
    setLookupState({ status: "loading" });
  }

  return (
    <>
      <PageHeader title={ko.equipment.title} description={ko.equipment.description} />
      <div className="grid gap-5 max-w-2xl">
        <Card className="grid gap-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="equipment-search">
              {ko.intake.managementNo}
            </label>
            <Input
              id="equipment-search"
              value={managementNo}
              placeholder={ko.intake.managementNoPlaceholder}
              list="equipment-search-suggestions"
              onChange={(e) => { handleChange(e.currentTarget.value); }}
            />
            {suggestions.length > 0 ? (
              <datalist id="equipment-search-suggestions">
                {suggestions.map((eq) => (
                  <option
                    key={eq.id}
                    value={eq.management_no ?? eq.equipment_no}
                    label={`${eq.model ?? ko.common.unknown} / ${eq.customer.name}`}
                  />
                ))}
              </datalist>
            ) : null}
          </div>

          {lookupState.status === "loading" ? (
            <p role="status" className="text-sm font-medium text-slate-700">
              {ko.intake.lookupLoading}
            </p>
          ) : null}
          {lookupState.status === "notFound" ? (
            <p
              aria-live="assertive"
              className="rounded-md border border-dashed border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800"
            >
              {ko.intake.lookupNotFound}
            </p>
          ) : null}
          {lookupState.status === "error" ? (
            <PageError message={ko.intake.lookupFailed} />
          ) : null}
          {lookupState.status === "ready" ? (
            <dl className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-semibold text-slate-600">{ko.intake.model}</dt>
                <dd className="text-slate-950">{lookupState.equipment.model}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-600">{ko.intake.customer}</dt>
                <dd className="text-slate-950">{lookupState.equipment.customerName}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-600">{ko.intake.site}</dt>
                <dd className="text-slate-950">{lookupState.equipment.siteName}</dd>
              </div>
            </dl>
          ) : null}
          {lookupState.status === "idle" ? (
            <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
              {ko.intake.lookupPrompt}
            </p>
          ) : null}
        </Card>
      </div>
    </>
  );
}
