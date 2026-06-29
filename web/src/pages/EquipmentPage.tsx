import { useCallback, useEffect, useState } from "react";

import type { EquipmentLookupResponse, EquipmentLookupState } from "../api/types";
import {
  listGroupAdminGroups,
  type GroupAdminGroup,
} from "../api/groupAdmin";
import { useAuth } from "../context/auth";
import { hasAnyRole, hasGroupAdminRole, ROLES } from "../components/shell/nav";
import { PageHeader } from "../components/shell/PageHeader";
import { PageError } from "../components/states/PageError";
import { EquipmentImportPanel } from "../features/equipment/EquipmentImportPanel";
import {
  EquipmentManagementPanel,
  type EquipmentOwnerOrgOption,
} from "../features/equipment/EquipmentManagementPanel";
import { ManagementNoCombobox } from "../features/equipment/ManagementNoCombobox";
import { SiteGeographyPanel } from "../features/equipment/SiteGeographyPanel";
import { SubstitutionPanel } from "../features/equipment/SubstitutionPanel";
import { Card } from "../components/ui/card";
import { ko } from "../i18n/ko";

const equipmentDebounceMs = 300;

/** EquipmentManage holders (backend matrix: ADMIN/EXECUTIVE/SUPER_ADMIN). */
const EQUIPMENT_MANAGE_ROLES = [
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
] as const;

/** MasterListImport holders (backend matrix: ADMIN/SUPER_ADMIN). */
const MASTER_IMPORT_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;

function flattenOwnerOrgOptions(
  groups: readonly GroupAdminGroup[],
): EquipmentOwnerOrgOption[] {
  return groups
    .flatMap((group) =>
      group.members.map((member) => ({
        id: member.id,
        name: member.name,
        slug: member.slug,
        groupName: group.name,
      })),
    )
    .sort(
      (a, b) =>
        a.groupName.localeCompare(b.groupName, "ko") ||
        a.name.localeCompare(b.name, "ko") ||
        a.slug.localeCompare(b.slug),
    );
}

export function EquipmentPage() {
  const { api, session, viewAs } = useAuth();
  const canManage = hasAnyRole(session?.roles, EQUIPMENT_MANAGE_ROLES);
  const canImport = hasAnyRole(session?.roles, MASTER_IMPORT_ROLES);
  const sourceIsGroupAdminContext = viewAs?.source === "GROUP_ADMIN";
  const canSelectEquipmentOwnerOrg =
    sourceIsGroupAdminContext || hasGroupAdminRole(session?.group_roles);
  const groupAdminSourceToken = sourceIsGroupAdminContext
    ? viewAs.platformSession.access_token
    : session?.access_token;
  const activeOrgId = viewAs?.actingOrgId ?? session?.org_id;
  const [managementNo, setManagementNo] = useState("");
  const [suggestions, setSuggestions] = useState<EquipmentLookupResponse[]>([]);
  const [lookupState, setLookupState] = useState<EquipmentLookupState>({ status: "idle" });
  const [ownerOrgOptions, setOwnerOrgOptions] = useState<
    EquipmentOwnerOrgOption[]
  >([]);
  const [selectedOwnerOrgId, setSelectedOwnerOrgId] = useState<string>();

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

  useEffect(() => {
    let cancelled = false;

    if (!canSelectEquipmentOwnerOrg || !groupAdminSourceToken) {
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setOwnerOrgOptions([]);
        setSelectedOwnerOrgId(undefined);
      });
      return () => {
        cancelled = true;
      };
    }

    async function loadOwnerOrgs() {
      try {
        const groups = await listGroupAdminGroups(groupAdminSourceToken);
        if (cancelled) return;
        setOwnerOrgOptions(flattenOwnerOrgOptions(groups));
      } catch {
        if (!cancelled) setOwnerOrgOptions([]);
      }
    }

    void loadOwnerOrgs();
    return () => {
      cancelled = true;
    };
  }, [canSelectEquipmentOwnerOrg, groupAdminSourceToken]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (!canSelectEquipmentOwnerOrg || ownerOrgOptions.length === 0) {
        setSelectedOwnerOrgId(undefined);
        return;
      }
      setSelectedOwnerOrgId((current) => {
        if (current && ownerOrgOptions.some((option) => option.id === current)) {
          return current;
        }
        if (activeOrgId && ownerOrgOptions.some((option) => option.id === activeOrgId)) {
          return activeOrgId;
        }
        return ownerOrgOptions[0]?.id;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeOrgId, canSelectEquipmentOwnerOrg, ownerOrgOptions]);

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
            <ManagementNoCombobox
              id="equipment-search"
              value={managementNo}
              onChange={handleChange}
              suggestions={suggestions}
              placeholder={ko.intake.managementNoPlaceholder}
            />
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
            ownerOrgOptions={ownerOrgOptions}
            ownerSelectionRequired={canSelectEquipmentOwnerOrg}
            selectedOwnerOrgId={selectedOwnerOrgId}
            onSelectedOwnerOrgIdChange={setSelectedOwnerOrgId}
            activeOrgId={activeOrgId}
            groupAdminSourceToken={groupAdminSourceToken}
          />
        ) : null}
        {/* Master-list bulk .xlsx import (MasterListImport: ADMIN/SUPER_ADMIN). */}
        {canImport ? (
          <EquipmentImportPanel api={api} onImported={refreshSearch} />
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
