import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEquipmentApi, EquipmentApiError, type CaseView, type UnitView } from "./equipmentApi";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const unit: UnitView = {
  id: "unit-1",
  serialNo: "FL-001",
  modelName: "D30S-7",
  capacityClass: "3.0t",
  availability: "AVAILABLE",
  acquisitionCostMinor: 30_000_000,
  branchId: "branch-1",
};

const rentalCase: CaseView = {
  id: "case-1",
  unitId: "unit-1",
  status: "QUOTED",
  customerName: "customer",
  siteReference: "site",
  monthlyRateMinor: 2_500_000,
  durationMonths: 12,
  currencyCode: "KRW",
  branchId: "branch-1",
};

function lastRequest(): { url: URL; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: new URL(call[0]), init: call[1] };
}

function requestHeaders(): Headers {
  return new Headers(lastRequest().init.headers);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createEquipmentApi", () => {
  it("lists units from the contract path with bearer auth", async () => {
    fetchMock.mockResolvedValue(jsonResponse([unit]));
    const api = createEquipmentApi("token-1");
    await expect(api.listUnits()).resolves.toEqual([unit]);
    const { url, init } = lastRequest();
    expect(url.pathname).toBe("/api/v1/equipment-3r/units");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(requestHeaders().get("Authorization")).toBe("Bearer token-1");
    expect(requestHeaders().get("Accept")).toBe("application/json");
  });

  it("creates a rental case with the Idempotency-Key header and contract body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(rentalCase, 201));
    const api = createEquipmentApi("token-1");
    const created = await api.createRentalCase(
      {
        branchId: "branch-1",
        unitId: "unit-1",
        customerName: "customer",
        siteReference: "site",
        monthlyRateMinor: 2_500_000,
        durationMonths: 12,
        currencyCode: "KRW",
      },
      "0d5c9b0a-6a51-4c29-9e0e-3c8d1f2a4b5c",
    );
    expect(created).toEqual(rentalCase);
    const { url, init } = lastRequest();
    expect(url.pathname).toBe("/api/v1/equipment-3r/rental-cases");
    expect(requestHeaders().get("Idempotency-Key")).toBe("0d5c9b0a-6a51-4c29-9e0e-3c8d1f2a4b5c");
    expect(requestHeaders().get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      branchId: "branch-1",
      unitId: "unit-1",
      customerName: "customer",
      siteReference: "site",
      monthlyRateMinor: 2_500_000,
      durationMonths: 12,
      currencyCode: "KRW",
    });
  });

  it("passes an idempotent replay (200, replayed:true) through unchanged", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...rentalCase, replayed: true }, 200));
    const api = createEquipmentApi("token-1");
    const replayed = await api.createRentalCase(
      {
        branchId: "branch-1",
        unitId: "unit-1",
        customerName: "customer",
        siteReference: "site",
        monthlyRateMinor: 2_500_000,
        durationMonths: 12,
        currencyCode: "KRW",
      },
      "0d5c9b0a-6a51-4c29-9e0e-3c8d1f2a4b5c",
    );
    expect(replayed.replayed).toBe(true);
  });

  it("surfaces the error envelope code and message on a 409 conflict", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "conflict", message: "unit already reserved" } }, 409),
    );
    const api = createEquipmentApi("token-1");
    const failure = await api
      .approval("case-1", { decision: "APPROVED" })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EquipmentApiError);
    const typed = failure as EquipmentApiError;
    expect(typed.status).toBe(409);
    expect(typed.code).toBe("conflict");
    expect(typed.message).toBe("unit already reserved");
  });

  it("falls back to a status-coded message when the error body is not the envelope", async () => {
    fetchMock.mockResolvedValue(new Response("upstream unavailable", { status: 503 }));
    const api = createEquipmentApi("token-1");
    const failure = await api.listRentalCases().then(() => undefined).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EquipmentApiError);
    expect((failure as EquipmentApiError).status).toBe(503);
    expect((failure as EquipmentApiError).message).toBe("equipment-3r request failed (503)");
  });

  it("targets every contract route with encoded path segments", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const api = createEquipmentApi("token-1");
    await api.getUnit("unit/1");
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/units/unit%2F1");
    await api.unitHistory("unit-1");
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/units/unit-1/history");
    await api.getRentalCase("case-1");
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/rental-cases/case-1");
    await api.dispatch("case-1", { carrierName: "carrier", vehicleReference: "truck-7" });
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/rental-cases/case-1/dispatch");
    await api.handover("case-1", {
      recipientName: "recipient",
      evidenceReference: "evidence://photo/1",
      handedOverAt: "2026-07-23T09:00:00.000Z",
    });
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/rental-cases/case-1/handover");
    await api.recordInspection("case-1", { outcome: "PASS", findings: "ok" });
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/rental-cases/case-1/inspections");
    await api.recordReturn("case-1", { returnedAt: "2026-07-23T09:00:00.000Z" });
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/rental-cases/case-1/return");
    await api.assessment("case-1", { conditionGrade: "B", findings: "wear", disposition: "REPAIR" });
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/rental-cases/case-1/assessment");
    await api.completeDisposition("disp-1", { costMinor: 120_000 });
    expect(lastRequest().url.pathname).toBe("/api/v1/equipment-3r/dispositions/disp-1/completion");
    expect(JSON.parse(lastRequest().init.body as string)).toEqual({ costMinor: 120_000 });
    await api.completeDisposition("disp-2", { saleAmountMinor: 9_000_000, buyerName: "buyer" });
    expect(JSON.parse(lastRequest().init.body as string)).toEqual({
      saleAmountMinor: 9_000_000,
      buyerName: "buyer",
    });
  });
});
