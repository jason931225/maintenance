import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient, type ConsoleApiClient } from "../../api/client";
import { createLogisticsApi, newIdempotencyKey } from "./logisticsApi";

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
  });
});
