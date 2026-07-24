import type { components } from "@maintenance/api-client-ts";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { ApiCallError } from "../../api/ontologyActions";
import { aggregateFixity, aggregateTsa, listEvidenceObjectPage, verifyEvidenceObject } from "./evidenceApi";

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

describe("listEvidenceObjectPage", () => {
  it("reads exactly one bounded page and exposes only a progressive next offset", async () => {
    const GET = vi.fn().mockResolvedValue({
      data: { items: [listRow("1"), listRow("2")], limit: 2, offset: 0, total: 3 },
      response: { status: 200 },
    });
    const controller = new AbortController();

    await expect(listEvidenceObjectPage({ GET } as unknown as ConsoleApiClient, 2, 0, controller.signal)).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "1" }), expect.objectContaining({ id: "2" })],
        offset: 0,
        nextOffset: 2,
        reportedTotal: 3,
        mayHaveMore: true,
      }),
    );
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith("/api/v1/evidence/objects", expect.objectContaining({
      params: { query: { limit: 2 } },
      signal: controller.signal,
    }));
  });

  it("does not claim a complete register when same-total pages uniquely reorder", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [listRow("1"), listRow("2")], limit: 2, offset: 0, total: 4 },
        response: { status: 200 },
      })
      .mockResolvedValueOnce({
        data: { items: [listRow("4"), listRow("3")], limit: 2, offset: 2, total: 4 },
        response: { status: 200 },
      });
    const api = { GET } as unknown as ConsoleApiClient;

    const first = await listEvidenceObjectPage(api, 2);
    const later = await listEvidenceObjectPage(api, 2, first.nextOffset);

    expect(first.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(later.items.map((item) => item.id)).toEqual(["4", "3"]);
    expect(first.reportedTotal).toBe(later.reportedTotal);
    expect(first.mayHaveMore).toBe(true);
    expect(later.mayHaveMore).toBe(true);
    expect(first).not.toHaveProperty("complete");
    expect(later).not.toHaveProperty("complete");
  });

  it("fails closed when a response does not describe the requested offset", async () => {
    const GET = vi.fn().mockResolvedValue({
      data: { items: [listRow("1")], limit: 1, offset: 1, total: 1 },
      response: { status: 200 },
    });

    await expect(listEvidenceObjectPage({ GET } as unknown as ConsoleApiClient, 1)).rejects.toThrow(
      "pagination offset did not match",
    );
  });

  it("fails closed when a response exceeds the requested page limit", async () => {
    const GET = vi.fn().mockResolvedValue({
      data: { items: [listRow("1"), listRow("2")], limit: 1, offset: 0, total: 2 },
      response: { status: 200 },
    });

    await expect(listEvidenceObjectPage({ GET } as unknown as ConsoleApiClient, 1)).rejects.toThrow(
      "pagination exceeded the requested page limit",
    );
  });

  it("passes abort to the bounded request and rejects before mapping its result", async () => {
    const controller = new AbortController();
    const GET = vi.fn(() => {
      controller.abort();
      return Promise.resolve({
        data: { items: [listRow("1")], limit: 1, offset: 0, total: 2 },
        response: { status: 200 },
      });
    });

    await expect(
      listEvidenceObjectPage({ GET } as unknown as ConsoleApiClient, 1, 0, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(GET).toHaveBeenCalledTimes(1);
  });
});


describe("verifyEvidenceObject", () => {
  it("returns unavailable only when the backend truthfully reports storage unavailable", async () => {
    const POST = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "evidence_store_unavailable", message: "storage is not configured" } },
      response: { status: 503 },
    });

    await expect(verifyEvidenceObject({ POST } as unknown as ConsoleApiClient, "ev-1")).resolves.toEqual({
      state: "unavailable",
      copyVerdicts: new Map(),
    });
  });

  it("keeps an indeterminate 200 report pending while preserving per-copy storage evidence", async () => {
    const POST = vi.fn().mockResolvedValue({
      data: {
        evidence_object_id: "ev-1",
        verified_at: "2026-07-24T00:00:00Z",
        outcome: "INDETERMINATE",
        copies: [
          { copy_id: "copy-1", copy_kind: "ORIGINAL", status: "CHECKSUM_UNAVAILABLE" },
          { copy_id: "copy-2", copy_kind: "DERIVATIVE", status: "STORAGE_ERROR" },
        ],
      },
      response: { status: 200 },
    });

    await expect(verifyEvidenceObject({ POST } as unknown as ConsoleApiClient, "ev-1")).resolves.toEqual({
      state: "unavailable",
      copyVerdicts: new Map([
        ["copy-1", "CHECKSUM_UNAVAILABLE"],
        ["copy-2", "STORAGE_ERROR"],
      ]),
    });
  });

  it("keeps a non-storage 503 retryable instead of falsely claiming evidence storage is unavailable", async () => {
    const POST = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "unavailable", message: "JWT verification is not configured" } },
      response: { status: 503 },
    });

    await expect(verifyEvidenceObject({ POST } as unknown as ConsoleApiClient, "ev-1")).rejects.toMatchObject({
      name: "ApiCallError",
      status: 503,
    } satisfies Partial<ApiCallError>);
  });

  it("preserves a denied verification request instead of relabeling it as unavailable", async () => {
    const POST = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "forbidden", message: "denied" } },
      response: { status: 403 },
    });

    await expect(verifyEvidenceObject({ POST } as unknown as ConsoleApiClient, "ev-1")).rejects.toMatchObject({
      name: "ApiCallError",
      status: 403,
    } satisfies Partial<ApiCallError>);
  });

  it("preserves a transient verification failure for the action layer to retry", async () => {
    const POST = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "internal", message: "storage probe failed" } },
      response: { status: 500 },
    });

    await expect(verifyEvidenceObject({ POST } as unknown as ConsoleApiClient, "ev-1")).rejects.toMatchObject({
      name: "ApiCallError",
      status: 500,
    } satisfies Partial<ApiCallError>);
  });
});
