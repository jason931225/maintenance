import type { components } from "@maintenance/api-client-ts";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { aggregateFixity, aggregateTsa, listEvidenceObjects } from "./evidenceApi";

type EvidenceCopyView = components["schemas"]["EvidenceCopyView"];
type TimestampAuthorityProofView = components["schemas"]["TimestampAuthorityProofView"];

// Only worm_status / status feed the aggregators, so a minimal cast keeps the
// fail-closed intent front and centre (including the deliberately out-of-enum
// value that the runtime must still treat as indeterminate).
function copy(wormStatus: string): EvidenceCopyView {
  return { worm_status: wormStatus } as unknown as EvidenceCopyView;
}

function proof(status: string): TimestampAuthorityProofView {
  return { status } as unknown as TimestampAuthorityProofView;
}

describe("aggregateFixity (fail-closed)", () => {
  it("returns PENDING for no copies — nothing to verify is never green", () => {
    expect(aggregateFixity([])).toBe("PENDING");
  });

  it("returns VERIFIED only when every copy is explicitly VERIFIED", () => {
    expect(aggregateFixity([copy("VERIFIED"), copy("VERIFIED")])).toBe("VERIFIED");
  });

  it("stays PENDING when any copy is still PENDING", () => {
    expect(aggregateFixity([copy("VERIFIED"), copy("PENDING")])).toBe("PENDING");
  });

  it("taints to MISMATCH on any FAILED copy", () => {
    expect(aggregateFixity([copy("VERIFIED"), copy("FAILED")])).toBe("MISMATCH");
  });

  it("treats an unrecognized worm_status as indeterminate (PENDING), never VERIFIED", () => {
    expect(aggregateFixity([copy("SEALED_SOMEHOW")])).toBe("PENDING");
  });
});

describe("aggregateTsa (fail-closed)", () => {
  it("returns MISSING when there are no proofs", () => {
    expect(aggregateTsa([])).toBe("MISSING");
  });

  it("returns VERIFIED only when every proof is explicitly VERIFIED", () => {
    expect(aggregateTsa([proof("VERIFIED"), proof("VERIFIED")])).toBe("VERIFIED");
  });

  it("stays PENDING when any proof is PENDING or MISSING", () => {
    expect(aggregateTsa([proof("VERIFIED"), proof("PENDING")])).toBe("PENDING");
    expect(aggregateTsa([proof("VERIFIED"), proof("MISSING")])).toBe("PENDING");
  });

  it("surfaces terminal-bad states with priority", () => {
    expect(aggregateTsa([proof("VERIFIED"), proof("FAILED")])).toBe("FAILED");
    expect(aggregateTsa([proof("VERIFIED"), proof("REVOKED")])).toBe("REVOKED");
    expect(aggregateTsa([proof("VERIFIED"), proof("EXPIRED_CA")])).toBe("EXPIRED_CA");
  });

  it("treats an unrecognized proof status as indeterminate (PENDING), never VERIFIED", () => {
    expect(aggregateTsa([proof("SOMETHING_NEW")])).toBe("PENDING");
  });
});

function listRow(id: string) {
  return {
    id,
    code: `EV-${id}`,
    title: `Evidence ${id}`,
    source: { source_type: "record_archive", source_id: `record-${id}` },
    classification: "Internal",
    current_custody_stage: "REGISTERED",
    legal_hold_state: "NONE",
    admissibility_status: "REVIEW_NEEDED",
    created_by: "user-1",
    updated_by: "user-1",
    created_at: "2026-07-24T00:00:00Z",
    updated_at: "2026-07-24T00:00:00Z",
  };
}

describe("listEvidenceObjects", () => {
  it("walks every backend page instead of silently truncating the record list at one page", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [listRow("1"), listRow("2")], limit: 2, offset: 0, total: 3 },
        response: { status: 200 },
      })
      .mockResolvedValueOnce({
        data: { items: [listRow("3")], limit: 2, offset: 2, total: 3 },
        response: { status: 200 },
      });
    const api = { GET } as unknown as ConsoleApiClient;

    await expect(listEvidenceObjects(api, 2)).resolves.toMatchObject([
      { id: "1" },
      { id: "2" },
      { id: "3" },
    ]);
    expect(GET).toHaveBeenNthCalledWith(1, "/api/v1/evidence/objects", expect.objectContaining({
      params: { query: { limit: 2 } },
    }));
    expect(GET).toHaveBeenNthCalledWith(2, "/api/v1/evidence/objects", expect.objectContaining({
      params: { query: { limit: 2, offset: 2 } },
    }));
  });

  it("fails closed when the backend declares more records but returns an empty later page", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [listRow("1")], limit: 1, offset: 0, total: 2 },
        response: { status: 200 },
      })
      .mockResolvedValueOnce({
        data: { items: [], limit: 1, offset: 1, total: 2 },
        response: { status: 200 },
      });
    const api = { GET } as unknown as ConsoleApiClient;

    await expect(listEvidenceObjects(api, 1)).rejects.toThrow("pagination returned an empty page");
  });

  it("fails closed when a later page repeats an already-seen record id", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [listRow("1"), listRow("2")], limit: 2, offset: 0, total: 3 },
        response: { status: 200 },
      })
      .mockResolvedValueOnce({
        data: { items: [listRow("2")], limit: 2, offset: 2, total: 3 },
        response: { status: 200 },
      });

    await expect(listEvidenceObjects({ GET } as unknown as ConsoleApiClient, 2)).rejects.toThrow(
      "duplicate evidence record id",
    );
  });

  it("fails closed when a response does not describe the requested offset", async () => {
    const GET = vi.fn().mockResolvedValue({
      data: { items: [listRow("1")], limit: 1, offset: 1, total: 1 },
      response: { status: 200 },
    });

    await expect(listEvidenceObjects({ GET } as unknown as ConsoleApiClient, 1)).rejects.toThrow(
      "pagination offset did not match",
    );
  });

  it("fails closed when a page exceeds its immutable declared total", async () => {
    const GET = vi.fn().mockResolvedValue({
      data: { items: [listRow("1"), listRow("2")], limit: 2, offset: 0, total: 1 },
      response: { status: 200 },
    });

    await expect(listEvidenceObjects({ GET } as unknown as ConsoleApiClient, 2)).rejects.toThrow(
      "pagination exceeded its declared total",
    );
  });

  it("fails closed when the declared total changes while paging", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [listRow("1")], limit: 1, offset: 0, total: 2 },
        response: { status: 200 },
      })
      .mockResolvedValueOnce({
        data: { items: [listRow("2")], limit: 1, offset: 1, total: 3 },
        response: { status: 200 },
      });

    await expect(listEvidenceObjects({ GET } as unknown as ConsoleApiClient, 1)).rejects.toThrow(
      "pagination total changed",
    );
  });

  it("stops before requesting a later page after its caller aborts", async () => {
    const controller = new AbortController();
    const GET = vi.fn(() => {
      controller.abort();
      return Promise.resolve({
        data: { items: [listRow("1")], limit: 1, offset: 0, total: 2 },
        response: { status: 200 },
      });
    });

    await expect(
      listEvidenceObjects({ GET } as unknown as ConsoleApiClient, 1, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith("/api/v1/evidence/objects", expect.objectContaining({
      signal: controller.signal,
    }));
  });

});
