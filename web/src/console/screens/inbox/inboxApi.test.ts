import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../../api/client";
import { createInboxApi, type InboxDocPage, type InboxDocSummary } from "./inboxApi";

function summary(id: string, title: string): InboxDocSummary {
  return {
    id,
    recipient_user_id: "00000000-0000-0000-0000-000000000001",
    kind: "payslip",
    title,
    locked: false,
    confirmed_at: null,
    created_at: "2026-07-01T00:00:00Z",
  };
}

function clientWithPages(pages: Array<InboxDocPage | Error>) {
  const GET = vi.fn(() => {
    const page = pages.shift();
    if (page instanceof Error) return Promise.reject(page);
    if (!page) return Promise.reject(new Error("unexpected request"));
    return Promise.resolve({ data: page });
  });
  return { client: { GET } as unknown as ConsoleApiClient, GET };
}

describe("createInboxApi.loadDocs", () => {
  it("aggregates every cursor page in stable server order", async () => {
    const first = summary("11111111-1111-1111-1111-111111111111", "newest");
    const second = summary("22222222-2222-2222-2222-222222222222", "middle");
    const third = summary("33333333-3333-3333-3333-333333333333", "oldest");
    const { client, GET } = clientWithPages([
      { items: [first, second], next_cursor: second.id },
      { items: [third], next_cursor: null },
    ]);

    await expect(createInboxApi(client).loadDocs("all")).resolves.toEqual([
      first,
      second,
      third,
    ]);
    expect(GET).toHaveBeenNthCalledWith(1, "/api/v1/me/inbox-docs", {
      params: { query: { filter: "all", limit: 100, before: undefined } },
    });
    expect(GET).toHaveBeenNthCalledWith(2, "/api/v1/me/inbox-docs", {
      params: { query: { filter: "all", limit: 100, before: second.id } },
    });
  });

  it("rejects the whole list when a later page fails", async () => {
    const first = summary("11111111-1111-1111-1111-111111111111", "partial");
    const { client, GET } = clientWithPages([
      { items: [first], next_cursor: first.id },
      new Error("later page failed"),
    ]);

    await expect(createInboxApi(client).loadDocs("pay")).rejects.toThrow(
      "later page failed",
    );
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the server repeats a continuation cursor", async () => {
    const first = summary("11111111-1111-1111-1111-111111111111", "first");
    const second = summary("22222222-2222-2222-2222-222222222222", "second");
    const { client, GET } = clientWithPages([
      { items: [first], next_cursor: first.id },
      { items: [second], next_cursor: first.id },
    ]);

    await expect(createInboxApi(client).loadDocs("all")).rejects.toThrow(
      "inbox pagination cursor repeated",
    );
    expect(GET).toHaveBeenCalledTimes(2);
  });
});
