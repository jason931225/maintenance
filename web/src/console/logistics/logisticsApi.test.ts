import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient, type ConsoleApiClient } from "../../api/client";
import { createLogisticsApi, newIdempotencyKey, toTimeWire } from "./logisticsApi";

describe("createLogisticsApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the authenticated console client for ASN creation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const created = await createLogisticsApi(createConsoleApiClient("bearer-token")).createAsn({
      branchId: "branch-1",
      warehouseCode: "WH-01",
      externalReference: "PO-778",
      sku: "SKU-9",
      expectedQuantity: 10,
    });
    expect(created).toEqual({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" });
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toContain("/api/v1/logistics/asns");
    expect(request.method).toBe("POST");
    expect(request.headers.get("Authorization")).toBe("Bearer bearer-token");
    expect(request.headers.get("X-Auth-Transport")).toBe("cookie");
    expect(await request.json()).toEqual({
      branchId: "branch-1",
      warehouseCode: "WH-01",
      externalReference: "PO-778",
      sku: "SKU-9",
      expectedQuantity: 10,
    });
  });

  it("serializes the pick body onto the wire despite the openapi client drift", async () => {
    // openapi.yaml omits this route's request body; the backend rejects a
    // body-less call, so the wrapper must still transmit the verified body.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ff-1", status: "SHORT_PICK", pickedQuantity: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createLogisticsApi(createConsoleApiClient("bearer-token")).pick("ff-1", {
      branchId: "branch-1",
      pickedQuantity: 3,
    });
    expect(result.status).toBe("SHORT_PICK");
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toContain("/api/v1/logistics/fulfillments/ff-1/pick");
    expect(await request.json()).toEqual({ branchId: "branch-1", pickedQuantity: 3 });
  });

  it("encodes release dueAt as the backend's time-crate tuple, never RFC3339", async () => {
    // The deployed rest crate deserializes dueAt as plain time::OffsetDateTime
    // (no rfc3339 annotation): an RFC3339 string is rejected with 422, so the
    // wire must carry [year, ordinal, h, m, s, nanos, 0, 0, 0] in UTC.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ff-1", status: "RELEASED", reservedQuantity: 5 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const released = await createLogisticsApi(createConsoleApiClient("bearer-token")).release({
      branchId: "branch-1",
      warehouseCode: "WH-01",
      sku: "SKU-9",
      requestedQuantity: 5,
      dueAt: "2026-07-30T10:00:00.000Z",
    });
    expect(released.status).toBe("RELEASED");
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(await request.json()).toEqual({
      branchId: "branch-1",
      warehouseCode: "WH-01",
      sku: "SKU-9",
      requestedQuantity: 5,
      dueAt: [2026, 211, 10, 0, 0, 0, 0, 0, 0],
    });
  });

  it("computes UTC ordinal days correctly across leap years and offsets", () => {
    // 2028 is a leap year: Mar 1 = 31 + 29 + 1 = day 61.
    expect(toTimeWire("2028-03-01T00:00:00.000Z")).toEqual([2028, 61, 0, 0, 0, 0, 0, 0, 0]);
    // Non-UTC input normalizes to UTC: 09:30+09:00 = 00:30Z same day.
    expect(toTimeWire("2026-01-01T09:30:15.250+09:00")).toEqual([
      2026, 1, 0, 30, 15, 250_000_000, 0, 0, 0,
    ]);
    // Dec 31 of a non-leap year is day 365.
    expect(toTimeWire("2026-12-31T23:59:59.000Z")).toEqual([2026, 365, 23, 59, 59, 0, 0, 0, 0]);
  });

  it("sends the caller-owned Idempotency-Key header on receipts", async () => {
    const api = {
      GET: vi.fn(),
      POST: vi.fn().mockResolvedValue({
        data: { id: "asn-1", status: "PARTIAL_RECEIVED", receivedQuantity: 4 },
        response: new Response(null, { status: 200 }),
      }),
    } as unknown as ConsoleApiClient;
    const key = newIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(16);
    const result = await createLogisticsApi(api).receive(
      "asn-1",
      { branchId: "branch-1", receivedQuantity: 4 },
      key,
    );
    expect(result.receivedQuantity).toBe(4);
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/logistics/asns/{asn_id}/receipts",
      expect.objectContaining({
        params: { path: { asn_id: "asn-1" }, header: { "Idempotency-Key": key } },
        body: { branchId: "branch-1", receivedQuantity: 4 },
      }),
    );
  });

  it("parses an idempotent replay instead of double-counting", async () => {
    const api = {
      GET: vi.fn(),
      POST: vi.fn().mockResolvedValue({
        data: { id: "asn-1", status: "PARTIAL_RECEIVED", replayed: true },
        response: new Response(null, { status: 200 }),
      }),
    } as unknown as ConsoleApiClient;
    const result = await createLogisticsApi(api).receive(
      "asn-1",
      { branchId: "branch-1", receivedQuantity: 4 },
      newIdempotencyKey(),
    );
    expect(result.replayed).toBe(true);
    expect(result.receivedQuantity).toBeUndefined();
  });

  it("surfaces a backend denial instead of synthesizing success", async () => {
    const api = {
      GET: vi.fn(),
      POST: vi.fn().mockResolvedValue({
        error: { error: { code: "conflict", message: "operational cost settles only after verified POD" } },
        response: new Response(null, { status: 409 }),
      }),
    } as unknown as ConsoleApiClient;
    await expect(
      createLogisticsApi(api).settle("ship-1", {
        branchId: "branch-1",
        currencyCode: "KRW",
        amountMinor: 120000,
        settledAt: "2026-07-23T09:00:00.000Z",
      }),
    ).rejects.toThrow("operational cost settles only after verified POD");
    // The settle call site must also ride the time-crate tuple encoding.
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/logistics/shipments/{shipment_id}/settlements",
      expect.objectContaining({
        body: expect.objectContaining({ settledAt: toTimeWire("2026-07-23T09:00:00.000Z") }),
      }),
    );
  });

  it("encodes pod confirmedAt as the time-crate tuple at its call site", async () => {
    const api = {
      GET: vi.fn(),
      POST: vi.fn().mockResolvedValue({
        data: {
          id: "ship-1",
          status: "DELIVERED",
          recipientConfirmedEvidenceReference: "evidence://pod/1",
          slaAssessment: "MET",
        },
        response: new Response(null, { status: 200 }),
      }),
    } as unknown as ConsoleApiClient;
    await createLogisticsApi(api).pod("ship-1", {
      branchId: "branch-1",
      recipientName: "recipient",
      evidenceReference: "evidence://pod/1",
      confirmedAt: "2026-07-23T09:00:00.000Z",
    });
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/logistics/shipments/{shipment_id}/pod",
      expect.objectContaining({
        body: expect.objectContaining({ confirmedAt: toTimeWire("2026-07-23T09:00:00.000Z") }),
      }),
    );
  });
});
