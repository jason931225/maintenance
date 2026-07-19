import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "./client";
import {
  OntologyWritePreconditionError,
  stageObjectTypeRevision,
  type CreateObjectTypeDraft,
  type ObjectTypeWriteVersion,
} from "./ontology";

const draft = {
  stable_key: "work_order",
  title: "Work order",
  backing_kind: "instance",
  properties: [],
  links: [],
  actions: [],
  analytics: [],
} as unknown as CreateObjectTypeDraft;

const expected: ObjectTypeWriteVersion = {
  etag: '"ont-object-type-key:00000000000000000000000000000001:r7"',
  keyWriteRevision: 7,
};

describe("ontology key write version", () => {
  it("passes the exact strong If-Match and AbortSignal and returns the successor token", async () => {
    const signal = new AbortController().signal;
    const put = vi.fn().mockResolvedValue({
      data: {
        id: "00000000-0000-0000-0000-000000000001",
        stable_key: "work_order",
        title: "Work order",
        backing_kind: "instance",
        schema_version: 2,
        lifecycle_state: "draft",
        key_write_revision: 8,
        key_write_etag:
          '"ont-object-type-key:00000000000000000000000000000001:r8"',
      },
      error: undefined,
      response: new Response(null, {
        status: 201,
        headers: {
          ETag: '"ont-object-type-key:00000000000000000000000000000001:r8"',
        },
      }),
    });
    const api = { PUT: put } as unknown as ConsoleApiClient;

    const receipt = await stageObjectTypeRevision(api, "work_order", draft, {
      expected,
      signal,
    });

    expect(put).toHaveBeenCalledWith("/api/v1/ontology/object-types/{key}", {
      params: {
        path: { key: "work_order" },
        header: { "If-Match": expected.etag },
      },
      body: draft,
      signal,
    });
    expect(receipt.writeVersion).toEqual({
      etag: '"ont-object-type-key:00000000000000000000000000000001:r8"',
      keyWriteRevision: 8,
    });
  });

  it("maps 412 to a typed rebase-required error carrying current server truth", async () => {
    const put = vi.fn().mockResolvedValue({
      data: undefined,
      error: {
        error: {
          code: "ontology_write_precondition_failed",
          message: "stale object type write validator",
          current_key_write_revision: 8,
        },
      },
      response: new Response(null, {
        status: 412,
        headers: {
          ETag: '"ont-object-type-key:00000000000000000000000000000001:r8"',
        },
      }),
    });
    const api = { PUT: put } as unknown as ConsoleApiClient;

    const error = await stageObjectTypeRevision(api, "work_order", draft, {
      expected,
      signal: new AbortController().signal,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(OntologyWritePreconditionError);
    expect(error).toMatchObject({
      current: {
        etag: '"ont-object-type-key:00000000000000000000000000000001:r8"',
        keyWriteRevision: 8,
      },
    });
  });

  it("fails closed when a successful write omits the required successor ETag", async () => {
    const put = vi.fn().mockResolvedValue({
      data: {
        id: "00000000-0000-0000-0000-000000000001",
        stable_key: "work_order",
        title: "Work order",
        backing_kind: "instance",
        schema_version: 2,
        lifecycle_state: "draft",
        key_write_revision: 8,
        key_write_etag:
          '"ont-object-type-key:00000000000000000000000000000001:r8"',
      },
      error: undefined,
      response: new Response(null, { status: 201 }),
    });
    const api = { PUT: put } as unknown as ConsoleApiClient;

    await expect(
      stageObjectTypeRevision(api, "work_order", draft, {
        expected,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("omitted or mismatched its strong ETag");
  });
});
