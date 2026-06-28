import { useCallback, useState } from "react";

import type { EquipmentLookupResponse } from "../api/types";
import { useAuth } from "../context/auth";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { PageHeader } from "../components/shell/PageHeader";
import { EquipmentImportPanel } from "../features/equipment/EquipmentImportPanel";
import { EquipmentManagementPanel } from "../features/equipment/EquipmentManagementPanel";
import { ManagementNoCombobox } from "../features/equipment/ManagementNoCombobox";
import { SiteGeographyPanel } from "../features/equipment/SiteGeographyPanel";
import { SubstitutionPanel } from "../features/equipment/SubstitutionPanel";
import { Card } from "../components/ui/card";
import { ko } from "../i18n/ko";
import { EquipmentBrowseSurface } from "./EquipmentBrowsePage";

const equipmentDebounceMs = 300;

/** MasterListImport holders (backend matrix: ADMIN/SUPER_ADMIN). */
const MASTER_IMPORT_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;

/**
 * Equipment management page (CRUD) for EquipmentManage holders
 * (ADMIN/EXECUTIVE/SUPER_ADMIN). Gated by RequireEquipmentManageRoute in the
 * router so non-holders are redirected to /equipment before reaching this page.
 *
 * Contains:
 *  - List-first equipment browse table for selecting the object to manage
 *  - Management-number search + single-equipment create/edit/decommission (EquipmentManagementPanel)
 *  - Master-list bulk .xlsx import (EquipmentImportPanel — ADMIN/SUPER_ADMIN only)
 *  - Site coordinate entry for the dispatch map (SiteGeographyPanel)
 */
export function EquipmentManagePage() {
  const { api, session } = useAuth();
  const canImport = hasAnyRole(session?.roles, MASTER_IMPORT_ROLES);

  const [managementNo, setManagementNo] = useState("");
  const [suggestions, setSuggestions] = useState<EquipmentLookupResponse[]>([]);

  const runSearch = useCallback(
    async (query: string, ignore: () => boolean) => {
      const autocompleteRes = await api
        .GET("/api/v1/equipment", {
          params: { query: { q: query, limit: 5 } },
        })
        .catch(() => undefined);

      if (ignore()) return;
      setSuggestions(autocompleteRes?.data?.items ?? []);
    },
    [api],
  );

  const refreshSearch = useCallback(() => {
    const query = managementNo.trim();
    if (!query) return;
    void runSearch(query, () => false).catch(() => { setSuggestions([]); });
  }, [managementNo, runSearch]);

  function handleChange(value: string) {
    setManagementNo(value);
    if (!value.trim()) {
      setSuggestions([]);
      return;
    }

    // Debounced autocomplete: fire-and-forget with a brief delay.
    const current = value;
    setTimeout(() => {
      void runSearch(current, () => false).catch(() => { setSuggestions([]); });
    }, equipmentDebounceMs);
  }

  return (
    <>
      <PageHeader
        title={ko.equipment.manage.title}
        description={ko.equipment.manage.description}
      />
      <div className="grid gap-5">
        <Card
          aria-labelledby="equipment-manage-list-title"
          className="grid gap-3 border-brand-teal/20 bg-brand-teal/5"
          role="region"
        >
          <div>
            <p className="text-sm font-semibold text-brand-teal">
              {ko.equipment.manage.listEyebrow}
            </p>
            <h2 id="equipment-manage-list-title" className="mt-1 text-lg font-semibold text-ink">
              {ko.equipment.manage.listTitle}
            </h2>
          </div>
          <p className="max-w-4xl text-sm text-steel">
            {ko.equipment.manage.listDescription}
          </p>
        </Card>
        <EquipmentBrowseSurface showHeader={false} />

        <section
          aria-labelledby="equipment-manage-tools-title"
          className="grid max-w-3xl gap-5"
        >
          <div>
            <p className="text-sm font-semibold text-brand-teal">
              {ko.equipment.manage.toolsEyebrow}
            </p>
            <h2 id="equipment-manage-tools-title" className="mt-1 text-lg font-semibold text-ink">
              {ko.equipment.manage.toolsTitle}
            </h2>
            <p className="mt-1 text-sm text-steel">
              {ko.equipment.manage.toolsDescription}
            </p>
          </div>

          {/* Management-number search: create / edit / decommission */}
          <Card className="grid gap-4">
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="manage-equipment-search"
              >
                {ko.intake.managementNo}
              </label>
              <ManagementNoCombobox
                id="manage-equipment-search"
                value={managementNo}
                onChange={handleChange}
                suggestions={suggestions}
                placeholder={ko.intake.managementNoPlaceholder}
              />
            </div>
            <p className="text-sm text-steel">{ko.equipment.searchToManage}</p>
          </Card>

          {/* Create / edit / decommission panel (EquipmentManage: ADMIN/EXECUTIVE/SUPER_ADMIN) */}
          <EquipmentManagementPanel
            api={api}
            results={suggestions}
            onMutated={refreshSearch}
          />

          {/* Site coordinate entry for dispatch map (EquipmentManage) */}
          <SiteGeographyPanel api={api} />

          {/* Bulk .xlsx master-list import (MasterListImport: ADMIN/SUPER_ADMIN) */}
          {canImport ? (
            <EquipmentImportPanel api={api} onImported={refreshSearch} />
          ) : null}

          {/* Substitute assignment / return — all EquipmentManage holders
              (route guard ensures only ADMIN/EXECUTIVE/SUPER_ADMIN reach here). */}
          <SubstitutionPanel api={api} results={suggestions} canManage={true} />
        </section>
      </div>
    </>
  );
}
