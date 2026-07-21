import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../../api/client";
import { createMyWorkApi } from "./myWorkApi";

function clientWithGet(get: ReturnType<typeof vi.fn>): ConsoleApiClient {
  return { GET: get } as unknown as ConsoleApiClient;
}

describe("createMyWorkApi action-inbox pagination", () => {
  it("loads one bounded page and preserves its cursor and total semantics", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        items: [{ id: "work:1" }],
        total: 501,
        total_is_exact: false,
        next_cursor: "cursor-1",
      },
    });

    const result = await createMyWorkApi(clientWithGet(get)).loadInbox();

    expect(result.items.map((item) => item.id)).toEqual(["work:1"]);
    expect(result).toMatchObject({
      total: 501,
      total_is_exact: false,
      next_cursor: "cursor-1",
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/v1/me/action-inbox", {
      params: { query: { limit: 200, cursor: undefined } },
    });
  });

  it("rejects a cursor that does not advance", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { items: [{ id: "work:2" }], total: 2, next_cursor: "same" },
    });

    await expect(createMyWorkApi(clientWithGet(get)).loadInbox("same")).rejects.toThrow(
      "action-inbox cursor did not advance",
    );
    expect(get).toHaveBeenCalledTimes(1);
  });
});
