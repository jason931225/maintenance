import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import {
  createAccountingPeriodLock,
  listAccountingPeriodLocks,
  unlockAccountingPeriodLock,
} from "./financeApi";

describe("period-lock finance API wrappers", () => {
  it("uses only generated period-lock operations with the accounting filter and exact request bodies", async () => {
    const api = createConsoleApiClient("period-lock-api-test-token");
    const GET = vi.spyOn(api, "GET").mockResolvedValue({ data: { items: [] } });
    const POST = vi
      .spyOn(api, "POST")
      .mockResolvedValue({ data: { id: "lock-1" } });

    await listAccountingPeriodLocks(api);
    await createAccountingPeriodLock(api, {
      domain: "accounting",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      reason: "결산 확정",
    });
    await unlockAccountingPeriodLock(api, "lock-1", { reason: "오류 정정" });

    expect(GET).toHaveBeenCalledWith("/api/v1/period-locks", {
      params: { query: { domain: "accounting" } },
      signal: undefined,
    });
    expect(POST).toHaveBeenNthCalledWith(1, "/api/v1/period-locks", {
      body: {
        domain: "accounting",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        reason: "결산 확정",
      },
    });
    expect(POST).toHaveBeenNthCalledWith(
      2,
      "/api/v1/period-locks/{lockId}/unlock",
      {
        params: { path: { lockId: "lock-1" } },
        body: { reason: "오류 정정" },
      },
    );
  });
});
