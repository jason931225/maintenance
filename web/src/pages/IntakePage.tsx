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
import { ROLES, hasAnyRole, type Role } from "../components/shell/nav";
import { IntakeForm } from "../features/intake/IntakeForm";
import { ko } from "../i18n/ko";

const equipmentDebounceMs = 300;

/**
 * Roles that hold WorkOrderCreate/EditIntake (the five operational roles). A
 * just-signed-up MEMBER is default-denied by the backend, so the form is hidden
 * for them and a permission notice is shown instead of a fillable form that only
 * 403s on submit. (ProtectedRoute already routes a bare MEMBER to /pending; this
 * is the in-page defense for any session that still reaches /intake.)
 */
const WORK_ORDER_CREATE_ROLES: readonly Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.MECHANIC,
  ROLES.RECEPTIONIST,
];

export function IntakePage() {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();
  const canCreateWorkOrder = hasAnyRole(session?.roles, WORK_ORDER_CREATE_ROLES);
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
        {!canCreateWorkOrder ? (
          <div
            role="alert"
            className="rounded-lg border border-line bg-muted-panel p-6"
          >
            <p className="text-sm font-semibold text-ink">
              {ko.intake.permissionDenied}
            </p>
            <p className="mt-1 text-sm text-steel">
              {ko.intake.permissionDeniedHint}
            </p>
          </div>
        ) : branchId ? (
          <IntakeForm
            branchId={branchId}
            equipmentLookupState={equipmentLookupState}
            equipmentSuggestions={equipmentSuggestions}
            onManagementNoChange={handleManagementNoChange}
            onCreateWorkOrder={createWorkOrder}
            // Keep the equipment context (managementNo + the resolved lookup
            // panel) after a successful submit so the receptionist can read the
            // returned request_no back to the caller and, if needed, file a
            // follow-up for the same machine. The form clears its own per-request
            // fields and surfaces the request_no + detail deep-link.
          />
        ) : (
          <PageEmpty message={ko.common.noBranch} />
        )}
      </div>
    </>
  );
}
