import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { logisticsStrings as text } from "../../i18n/logistics";
import type { LogisticsCapabilities } from "./logisticsCapabilities";
import { LogisticsScreen } from "./LogisticsScreen";

const none: LogisticsCapabilities = {
  canRead: false,
  canReceive: false,
  canPutaway: false,
  canRelease: false,
  canPickPack: false,
  canDispatch: false,
  canPod: false,
  canSettle: false,
};
const all: LogisticsCapabilities = {
  canRead: true,
  canReceive: true,
  canPutaway: true,
  canRelease: true,
  canPickPack: true,
  canDispatch: true,
  canPod: true,
  canSettle: true,
};
const receiver: LogisticsCapabilities = { ...none, canRead: true, canReceive: true };

function ok<T>(data: T) {
  return { data, response: new Response(null, { status: 200 }) };
}

function denialOf(status: number, message: string) {
  return {
    error: { error: { code: "conflict", message } },
    response: new Response(null, { status }),
  };
}

/** Per-path FIFO of scripted responses; an unscripted call is a test failure. */
function routed(map: Partial<Record<string, unknown[]>>) {
  const POST = vi.fn((path: string) => {
    const queue = map[path];
    if (!queue || queue.length === 0) {
      return Promise.resolve({
        error: { error: { code: "internal", message: `unscripted POST ${path}` } },
        response: new Response(null, { status: 500 }),
      });
    }
    return Promise.resolve(queue.shift());
  });
  return { GET: vi.fn(), POST } as unknown as ConsoleApiClient;
}

function renderScreen(capabilities: LogisticsCapabilities, api: ConsoleApiClient, sessionKey = "session-a") {
  return render(
    <LogisticsScreen
      api={api}
      branchId="branch-1"
      actorId="user-1"
      capabilities={capabilities}
      sessionKey={sessionKey}
    />,
  );
}

async function createAsnThroughForm(user: ReturnType<typeof userEvent.setup>) {
  const form = screen.getByRole("form", { name: text.createAsn });
  await user.type(within(form).getByLabelText(text.warehouse), "WH-01");
  await user.type(within(form).getByLabelText(text.externalReference), "PO-778");
  await user.type(within(form).getByLabelText(text.sku), "SKU-9");
  await user.type(within(form).getByLabelText(text.expectedQuantity), "10");
  await user.click(within(form).getByRole("button", { name: text.createAsn }));
}

describe("LogisticsScreen", () => {
  it("denies an unauthorized user before fetching or exposing controls", () => {
    const api = routed({});
    renderScreen(none, api);
    expect(screen.getByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
    expect(api.GET).not.toHaveBeenCalled();
  });

  it("starts from truthful empty queues because the backend has no read surface", () => {
    renderScreen(all, routed({}));
    expect(screen.getByText(text.asnEmpty)).toBeVisible();
    expect(screen.getByText(text.fulfillmentEmpty)).toBeVisible();
    expect(screen.getByText(text.shipmentEmpty)).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("creates an ASN from the backend response and reveals its detail", async () => {
    const user = userEvent.setup();
    const api = routed({
      "/api/v1/logistics/asns": [ok({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" })],
    });
    renderScreen(all, api);
    await createAsnThroughForm(user);
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/logistics/asns",
      expect.objectContaining({
        body: {
          branchId: "branch-1",
          warehouseCode: "WH-01",
          externalReference: "PO-778",
          sku: "SKU-9",
          expectedQuantity: 10,
        },
      }),
    );
    const queue = screen.getByRole("list", { name: text.asnQueue });
    expect(within(queue).getByText(text.asnStatus.EXPECTED)).toBeVisible();
    expect(screen.getByText("PO-778")).toBeVisible();
    expect(screen.getByRole("form", { name: text.receive })).toBeVisible();
  });

  it("retries a failed receipt with the same idempotency key, then applies the backend result", async () => {
    const user = userEvent.setup();
    const receiptsPath = "/api/v1/logistics/asns/{asn_id}/receipts";
    const api = routed({
      "/api/v1/logistics/asns": [ok({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" })],
      [receiptsPath]: [
        denialOf(409, "receipt exceeds expected quantity"),
        ok({ id: "asn-1", status: "PARTIAL_RECEIVED", receivedQuantity: 4 }),
      ],
    });
    renderScreen(all, api);
    await createAsnThroughForm(user);
    const receiveForm = screen.getByRole("form", { name: text.receive });
    await user.type(within(receiveForm).getByLabelText(text.receivedQuantity), "4");
    await user.click(within(receiveForm).getByRole("button", { name: text.receive }));
    expect(await screen.findByRole("alert")).toHaveTextContent("receipt exceeds expected quantity");

    await user.click(screen.getByRole("button", { name: text.retry }));
    await waitFor(() => { expect(screen.queryByRole("alert")).toBeNull(); });
    const receiptCalls = vi
      .mocked(api.POST)
      .mock.calls.filter(([path]) => path === receiptsPath)
      .map(([, init]) => init as { params: { header: { "Idempotency-Key": string } } });
    expect(receiptCalls).toHaveLength(2);
    expect(receiptCalls[0]?.params.header["Idempotency-Key"]).toBe(
      receiptCalls[1]?.params.header["Idempotency-Key"],
    );
    const queue = screen.getByRole("list", { name: text.asnQueue });
    expect(within(queue).getByText(text.asnStatus.PARTIAL_RECEIVED)).toBeVisible();
    expect(screen.getByText(`${text.receivedTotal} 4`)).toBeVisible();
  });

  it("marks an idempotent replay without double-counting the receipt total", async () => {
    const user = userEvent.setup();
    const api = routed({
      "/api/v1/logistics/asns": [ok({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" })],
      "/api/v1/logistics/asns/{asn_id}/receipts": [
        ok({ id: "asn-1", status: "PARTIAL_RECEIVED", receivedQuantity: 4 }),
        ok({ id: "asn-1", status: "PARTIAL_RECEIVED", replayed: true }),
      ],
    });
    renderScreen(all, api);
    await createAsnThroughForm(user);
    for (let round = 0; round < 2; round += 1) {
      const receiveForm = screen.getByRole("form", { name: text.receive });
      await user.type(within(receiveForm).getByLabelText(text.receivedQuantity), "4");
      await user.click(within(receiveForm).getByRole("button", { name: text.receive }));
      await waitFor(() => {
        expect(within(receiveForm).getByLabelText(text.receivedQuantity)).toHaveValue(null);
      });
    }
    expect(screen.getByText(text.replayed)).toBeVisible();
    expect(screen.getByText(`${text.receivedTotal} 4`)).toBeVisible();
    const queue = screen.getByRole("list", { name: text.asnQueue });
    expect(within(queue).getByText("4/10")).toBeVisible();
  });

  it("activates queue selection with the keyboard and offers only legal-state actions", async () => {
    const user = userEvent.setup();
    const api = routed({
      "/api/v1/logistics/asns": [ok({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" })],
      "/api/v1/logistics/asns/{asn_id}/receipts": [
        ok({ id: "asn-1", status: "RECEIVED", receivedQuantity: 10 }),
      ],
    });
    renderScreen(all, api);
    await createAsnThroughForm(user);
    const receiveForm = screen.getByRole("form", { name: text.receive });
    await user.type(within(receiveForm).getByLabelText(text.receivedQuantity), "10");
    await user.click(within(receiveForm).getByRole("button", { name: text.receive }));
    await waitFor(() => { expect(screen.queryByRole("form", { name: text.receive })).toBeNull(); });

    const queue = screen.getByRole("list", { name: text.asnQueue });
    const item = within(queue).getByRole("button");
    item.focus();
    await user.keyboard("{Enter}");
    expect(item).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: text.putaway })).toBeVisible();
  });

  it("renders deny-by-omission for a receive-only persona: no putaway, release, or dispatch controls", async () => {
    const user = userEvent.setup();
    const api = routed({
      "/api/v1/logistics/asns": [ok({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" })],
      "/api/v1/logistics/asns/{asn_id}/receipts": [
        ok({ id: "asn-1", status: "RECEIVED", receivedQuantity: 10 }),
      ],
    });
    renderScreen(receiver, api);
    await createAsnThroughForm(user);
    const receiveForm = screen.getByRole("form", { name: text.receive });
    await user.type(within(receiveForm).getByLabelText(text.receivedQuantity), "10");
    await user.click(within(receiveForm).getByRole("button", { name: text.receive }));
    await waitFor(() => { expect(screen.queryByRole("form", { name: text.receive })).toBeNull(); });
    expect(screen.queryByRole("button", { name: text.putaway })).toBeNull();
    expect(screen.queryByRole("form", { name: text.release })).toBeNull();
    expect(screen.queryByRole("form", { name: text.dispatch })).toBeNull();
  });

  it("walks the outbound chain to a settled shipment with traversable links", async () => {
    const user = userEvent.setup();
    const api = routed({
      "/api/v1/logistics/fulfillments": [
        ok({ id: "ff-1", status: "RELEASED", reservedQuantity: 5 }),
      ],
      "/api/v1/logistics/fulfillments/{fulfillment_id}/pick": [
        ok({ id: "ff-1", status: "SHORT_PICK", pickedQuantity: 3 }),
      ],
      "/api/v1/logistics/fulfillments/{fulfillment_id}/pack": [
        ok({ id: "ff-1", status: "PACKED", pickedQuantity: 3 }),
      ],
      "/api/v1/logistics/fulfillments/{fulfillment_id}/dispatch": [
        ok({ id: "ship-1", fulfillmentId: "ff-1", status: "DISPATCHED" }),
      ],
      "/api/v1/logistics/shipments/{shipment_id}/pod": [
        ok({
          id: "ship-1",
          status: "DELIVERED",
          recipientConfirmedEvidenceReference: "evidence://pod/1",
          slaAssessment: "MET",
        }),
      ],
      "/api/v1/logistics/shipments/{shipment_id}/settlements": [
        ok({
          id: "ship-1",
          status: "SETTLED",
          operationalCost: { currency: "KRW", amountMinor: 120000 },
          financeGlPosting: null,
        }),
      ],
    });
    renderScreen(all, api);

    const releaseForm = screen.getByRole("form", { name: text.release });
    await user.type(within(releaseForm).getByLabelText(text.warehouse), "WH-01");
    await user.type(within(releaseForm).getByLabelText(text.sku), "SKU-9");
    await user.type(within(releaseForm).getByLabelText(text.requestedQuantity), "5");
    fireEvent.change(within(releaseForm).getByLabelText(text.dueAt), {
      target: { value: "2026-07-30T10:00" },
    });
    await user.click(within(releaseForm).getByRole("button", { name: text.release }));
    expect(await screen.findByRole("form", { name: text.pick })).toBeVisible();

    const pickForm = screen.getByRole("form", { name: text.pick });
    await user.type(within(pickForm).getByLabelText(text.pickedQuantity), "3");
    await user.click(within(pickForm).getByRole("button", { name: text.pick }));
    expect(await screen.findByRole("button", { name: text.pack })).toBeVisible();
    const fulfillmentQueue = screen.getByRole("list", { name: text.fulfillmentQueue });
    expect(within(fulfillmentQueue).getByText(text.fulfillmentStatus.SHORT_PICK)).toBeVisible();

    await user.click(screen.getByRole("button", { name: text.pack }));
    expect(await screen.findByRole("form", { name: text.dispatch })).toBeVisible();

    const dispatchForm = screen.getByRole("form", { name: text.dispatch });
    await user.type(within(dispatchForm).getByLabelText(text.carrierName), "한진");
    await user.type(within(dispatchForm).getByLabelText(text.vehicleReference), "88도7788");
    await user.click(within(dispatchForm).getByRole("button", { name: text.dispatch }));
    expect(await screen.findByRole("form", { name: text.pod })).toBeVisible();

    await user.click(screen.getByRole("button", { name: text.linkedFulfillment }));
    expect(screen.getByRole("heading", { name: `${text.fulfillment} SKU-9` })).toBeVisible();
    await user.click(screen.getByRole("button", { name: text.linkedShipment }));
    expect(screen.getByRole("heading", { name: `${text.shipment} 한진` })).toBeVisible();

    const podForm = screen.getByRole("form", { name: text.pod });
    await user.type(within(podForm).getByLabelText(text.recipientName), "김수령");
    await user.type(within(podForm).getByLabelText(text.evidenceReference), "evidence://pod/1");
    fireEvent.change(within(podForm).getByLabelText(text.confirmedAt), {
      target: { value: "2026-07-29T18:00" },
    });
    await user.click(within(podForm).getByRole("button", { name: text.pod }));
    expect((await screen.findAllByText(text.sla.MET)).length).toBeGreaterThan(0);
    expect(screen.getByText("evidence://pod/1")).toBeVisible();

    const settleForm = screen.getByRole("form", { name: text.settle });
    await user.type(within(settleForm).getByLabelText(text.amountMinor), "120000");
    fireEvent.change(within(settleForm).getByLabelText(text.settledAt), {
      target: { value: "2026-07-30T09:00" },
    });
    await user.click(within(settleForm).getByRole("button", { name: text.settle }));
    expect(await screen.findByText("120000")).toBeVisible();
    const shipmentQueue = screen.getByRole("list", { name: text.shipmentQueue });
    expect(within(shipmentQueue).getByText(text.shipmentStatus.SETTLED)).toBeVisible();
  });

  it("filters the working set without discarding it", async () => {
    const user = userEvent.setup();
    const api = routed({
      "/api/v1/logistics/asns": [ok({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" })],
    });
    renderScreen(all, api);
    await createAsnThroughForm(user);
    await user.type(screen.getByLabelText(text.filter), "없는검색어");
    const queue = screen.getByRole("list", { name: text.asnQueue });
    expect(within(queue).getByText(text.noMatch)).toBeVisible();
    await user.clear(screen.getByLabelText(text.filter));
    expect(within(queue).getByText("SKU-9")).toBeVisible();
  });

  it("fences a stale mutation when the session is replaced", async () => {
    const user = userEvent.setup();
    let resolveCreate!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    const api = {
      GET: vi.fn(),
      POST: vi.fn().mockReturnValue(pending),
    } as unknown as ConsoleApiClient;
    const view = renderScreen(all, api);
    await createAsnThroughForm(user);
    const init = vi.mocked(api.POST).mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;

    view.rerender(
      <LogisticsScreen
        api={api}
        branchId="branch-1"
        actorId="user-1"
        capabilities={all}
        sessionKey="session-b"
      />,
    );
    resolveCreate(ok({ id: "asn-1", status: "EXPECTED", branchId: "branch-1" }));
    await waitFor(() => {
      const queue = screen.getByRole("list", { name: text.asnQueue });
      expect(within(queue).getByText(text.asnEmpty)).toBeVisible();
    });
    expect(init?.signal?.aborted).toBe(true);
  });
});
