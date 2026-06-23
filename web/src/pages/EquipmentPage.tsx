import { useCallback, useEffect, useState } from "react";

import type { EquipmentLookupResponse, EquipmentLookupState } from "../api/types";
import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { PageHeader } from "../components/shell/PageHeader";
import { PageError } from "../components/states/PageError";
import { EquipmentManagementPanel } from "../features/equipment/EquipmentManagementPanel";
import { SiteGeographyPanel } from "../features/equipment/SiteGeographyPanel";
import { SubstitutionPanel } from "../features/equipment/SubstitutionPanel";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { ko } from "../i18n/ko";

const equipmentDebounceMs = 300;

/** EquipmentManage holders (backend matrix: ADMIN/EXECUTIVE/SUPER_ADMIN). */
const EQUIPMENT_MANAGE_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

export function EquipmentPage() {
  const { api, session } = useAuth();
  const canManage = hasAnyRole(session?.roles, EQUIPMENT_MANAGE_ROLES);
  const [managementNo, setManagementNo] = useState("");
  const [suggestions, setSuggestions] = useState<EquipmentLookupResponse[]>([]);
  const [lookupState, setLookupState] = useState<EquipmentLookupState>({ status: "idle" });

  const runSearch = useCallback(
    async (query: string, ignore: () => boolean) => {
      const [autocompleteResponse, lookupResponse] = await Promise.all([
        api.GET("/api/v1/equipment", {
          params: { query: { q: query, limit: 5 } },
        }),
        api.GET("/api/v1/equipment/lookup", {
          params: { query: { management_no: query } },
        }),
      ]);

      if (ignore()) return;

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
            maker: eq.maker,
            vin: eq.vin,
            vehicleRegistrationNo: eq.vehicle_registration_no,
          },
        });
        return;
      }
      setLookupState({ status: "notFound" });
    },
    [api],
  );

  const refreshSearch = useCallback(() => {
    const query = managementNo.trim();
    if (!query) return;
    runSearch(query, () => false).catch(() => {
      setSuggestions([]);
      setLookupState({ status: "error" });
    });
  }, [managementNo, runSearch]);

  useEffect(() => {
    const query = managementNo.trim();
    let ignore = false;

    if (!query) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      runSearch(query, () => ignore).catch(() => {
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
  }, [managementNo, runSearch]);

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
      <div className={`grid gap-5 ${canManage ? "max-w-4xl" : "max-w-2xl"}`}>
        <Card className="grid gap-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium text-steel" htmlFor="equipment-search">
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
            <p role="status" className="text-sm font-medium text-steel">
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
            <dl className="grid gap-2 rounded-md border border-line bg-muted-panel p-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-semibold text-steel">{ko.intake.model}</dt>
                <dd className="text-ink">{lookupState.equipment.model}</dd>
              </div>
              <div>
                <dt className="font-semibold text-steel">{ko.intake.customer}</dt>
                <dd className="text-ink">{lookupState.equipment.customerName}</dd>
              </div>
              <div>
                <dt className="font-semibold text-steel">{ko.intake.site}</dt>
                <dd className="text-ink">{lookupState.equipment.siteName}</dd>
              </div>
            </dl>
          ) : null}
          {lookupState.status === "idle" ? (
            <p className="rounded-md border border-dashed border-line bg-muted-panel p-3 text-sm text-steel">
              {ko.intake.lookupPrompt}
            </p>
          ) : null}
        </Card>

        {canManage ? (
          <EquipmentManagementPanel
            api={api}
            results={suggestions}
            onMutated={refreshSearch}
          />
        ) : null}
        {/* Site coordinate entry feeds the dispatch map; coordinates are
            admin-entered (EquipmentManage) and exist only once saved here. */}
        {canManage ? <SiteGeographyPanel api={api} /> : null}
        {/* Reading substitute candidates is a read-access capability available to
            mechanics; only the assign/return mutations require EquipmentManage,
            which the panel gates internally via `canManage`. */}
        <SubstitutionPanel api={api} results={suggestions} canManage={canManage} />
      </div>
    </>
  );
}
