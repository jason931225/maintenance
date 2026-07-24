import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { ComplianceFramework } from "./types";
import { EVIDENCE_READ_CONCURRENCY, readEvidenceBindingWorkspace, readFrameworkDetail } from "./complianceApi";

const framework: ComplianceFramework = {
  kind: "framework", id: "framework-1", code: "FW-0001", title: "ISMS", versionLabel: "2025",
  frameworkKind: "SECURITY_STANDARD", status: "ACTIVE", metadata: {}, createdBy: "creator", updatedBy: "updater",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", controls: [],
};

function control(index: number) {
  return {
    id: `control-${String(index)}`, framework_id: "framework-1", control_key: `ISMS-${String(index)}`, title: `Control ${String(index)}`,
    objective: "Objective", control_type: "PREVENTIVE", cadence: "ANNUAL", status: "ACTIVE", evidence_requirements: {},
    owner_user_id: null, created_by: "creator", updated_by: "updater", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

function page(items: unknown[]) { return { items, limit: 100, offset: 0, total: items.length }; }

describe("readFrameworkDetail", () => {
  it("caps evidence reads while retaining control order", async () => {
    const controls = Array.from({ length: EVIDENCE_READ_CONCURRENCY + 3 }, (_, index) => control(index + 1));
    let active = 0;
    let maximum = 0;
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/compliance/framework-controls") return Promise.resolve({ data: page(controls) });
      if (path === "/api/v1/compliance/evidence-bindings") {
        active += 1;
        maximum = Math.max(maximum, active);
        return new Promise((resolve) => setTimeout(() => {
          active -= 1;
          resolve({ data: page([]) });
        }, 1));
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const detail = await readFrameworkDetail({ GET } as unknown as ConsoleApiClient, framework, new AbortController().signal);
    expect(maximum).toBeLessThanOrEqual(EVIDENCE_READ_CONCURRENCY);
    expect(detail.controls.map((item) => item.id)).toEqual(controls.map((item) => item.id));
  });

  it("forwards cancellation into the active generated-path request", async () => {
    let observedSignal: AbortSignal | undefined;
    const GET = vi.fn((_path: string, init: { signal?: AbortSignal }) => new Promise((_, reject) => {
      observedSignal = init.signal;
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }));
    const controller = new AbortController();
    const pending = readFrameworkDetail({ GET } as unknown as ConsoleApiClient, framework, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(true);
  });
  it.each([401, 403])("preserves a generated %i authorization result as ApiCallError", async (status) => {
    const error = { error: { code: status === 401 ? "unauthenticated" : "forbidden", message: "not authorized" } };
    const GET = vi.fn(() => Promise.resolve({
      error,
      response: new Response(JSON.stringify(error), { status }),
    }));

    await expect(readEvidenceBindingWorkspace(
      { GET } as unknown as ConsoleApiClient,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ status, code: error.error.code }));
  });

});
