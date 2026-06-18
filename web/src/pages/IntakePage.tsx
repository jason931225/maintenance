import { useEffect, useState } from "react";

import type {
  CreateWorkOrderRequest,
  EquipmentLookupResponse,
  EquipmentLookupState,
  WorkOrderSummary,
} from "../api/types";
import { useActiveBranchId, useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { PageEmpty } from "../components/states/PageEmpty";
import { IntakeForm } from "../features/intake/IntakeForm";
import { ko } from "../i18n/ko";

const equipmentDebounceMs = 300;

export function IntakePage() {
  const { api } = useAuth();
  const branchId = useActiveBranchId();
  const [managementNo, setManagementNo] = useState("");
  const [equipmentSuggestions, setEquipmentSuggestions] = useState<EquipmentLookupResponse[]>([]);
  const [equipmentLookupState, setEquipmentLookupState] = useState<EquipmentLookupState>({ status: "idle" });

  useEffect(() => {
    const query = managementNo.trim();
    let ignore = false;

    if (!query) {
      return undefined;
    }

    async function loadEquipment() {
      const [autocompleteResponse, lookupResponse] = await Promise.all([
        api.GET("/api/v1/equipment", {
          params: { query: { q: query, limit: 5 } },
        }),
        api.GET("/api/v1/equipment/lookup", {
          params: { query: { management_no: query } },
        }),
      ]);

      if (ignore) return;

      setEquipmentSuggestions(autocompleteResponse.data?.items ?? []);
      if (lookupResponse.data) {
        const eq = lookupResponse.data;
        setEquipmentLookupState({
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
      setEquipmentLookupState({ status: "notFound" });
    }

    const timer = window.setTimeout(() => {
      loadEquipment().catch(() => {
        if (!ignore) {
          setEquipmentSuggestions([]);
          setEquipmentLookupState({ status: "error" });
        }
      });
    }, equipmentDebounceMs);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [api, managementNo]);

  function handleManagementNoChange(nextManagementNo: string) {
    setManagementNo(nextManagementNo);
    if (nextManagementNo.trim().length === 0) {
      setEquipmentSuggestions([]);
      setEquipmentLookupState({ status: "idle" });
      return;
    }
    setEquipmentLookupState({ status: "loading" });
  }

  async function createWorkOrder(request: CreateWorkOrderRequest): Promise<WorkOrderSummary> {
    const response = await api.POST("/api/work-orders", { body: request });
    if (!response.data) {
      throw new Error("createWorkOrder response missing data");
    }
    return response.data;
  }

  return (
    <>
      <PageHeader title={ko.intake.title} description={ko.intake.description} />
      <div className="max-w-2xl">
        {branchId ? (
          <IntakeForm
            branchId={branchId}
            equipmentLookupState={equipmentLookupState}
            equipmentSuggestions={equipmentSuggestions}
            onManagementNoChange={handleManagementNoChange}
            onCreateWorkOrder={createWorkOrder}
            onCreated={() => {
              setManagementNo("");
              setEquipmentSuggestions([]);
              setEquipmentLookupState({ status: "idle" });
            }}
          />
        ) : (
          <PageEmpty message={ko.common.noBranch} />
        )}
      </div>
    </>
  );
}
