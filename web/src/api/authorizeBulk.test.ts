import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "./client";
import {
  authorizeBulk,
  clearAuthorizeBulkCache,
  subjectFingerprint,
  type AuthorizeSubject,
} from "./authorizeBulk";

const ORG = "11111111-1111-4111-8111-111111111111";
const SUBJECT: AuthorizeSubject = { org: ORG, userId: "u1", roles: ["ADMIN"] };

function effects(...effs: ("allow" | "deny")[]) {
  return {
    data: {
      decisions: effs.map((effect) => ({
        effect,
        determining_policies: [],
        errors: [],
        reason: "",
      })),
    },
  };
}

/** Fake client whose POST returns queued results. */
function fakeApi(post: ReturnType<typeof vi.fn>): ConsoleApiClient {
  return { POST: post } as unknown as ConsoleApiClient;
}

beforeEach(() => {
  clearAuthorizeBulkCache();
});

describe("authorizeBulk", () => {
  it("maps index-aligned decisions to action → allow", async () => {
    const post = vi.fn().mockResolvedValue(effects("allow", "deny"));
    const map = await authorizeBulk(fakeApi(post), SUBJECT, ["a.read", "a.write"]);
    expect(map.get("a.read")).toBe(true);
    expect(map.get("a.write")).toBe(false);
  });

  it("sends the principal as subject and one check per action", async () => {
    const post = vi.fn().mockResolvedValue(effects("allow"));
    await authorizeBulk(fakeApi(post), SUBJECT, ["a.read"]);
    expect(post).toHaveBeenCalledWith("/api/v1/policy/authorize/bulk", {
      body: {
        subject: { org: ORG, user_id: "u1", roles: ["ADMIN"] },
        checks: [{ action: "a.read", resource: { org: ORG, resource_type: "a.read" } }],
      },
    });
  });

  it("rejects (fail closed) on an HTTP/network error result", async () => {
    const post = vi.fn().mockResolvedValue({ error: { error: { message: "boom" } } });
    await expect(authorizeBulk(fakeApi(post), SUBJECT, ["a.read"])).rejects.toThrow();
  });

  it("rejects on a decision array whose length does not match the checks", async () => {
    const post = vi.fn().mockResolvedValue(effects("allow")); // 1 for 2 checks
    await expect(
      authorizeBulk(fakeApi(post), SUBJECT, ["a.read", "a.write"]),
    ).rejects.toThrow();
  });

  it("caches a success per session (one round-trip for repeat calls)", async () => {
    const post = vi.fn().mockResolvedValue(effects("allow"));
    await authorizeBulk(fakeApi(post), SUBJECT, ["a.read"]);
    await authorizeBulk(fakeApi(post), SUBJECT, ["a.read"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cache on a role change (new fingerprint → re-fetch)", async () => {
    const post = vi.fn().mockResolvedValue(effects("allow"));
    await authorizeBulk(fakeApi(post), SUBJECT, ["a.read"]);
    const elevated: AuthorizeSubject = { ...SUBJECT, roles: ["ADMIN", "SUPER_ADMIN"] };
    await authorizeBulk(fakeApi(post), elevated, ["a.read"]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(subjectFingerprint(SUBJECT)).not.toBe(subjectFingerprint(elevated));
  });

  it("does not cache a failure (a later retry re-requests)", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ error: {} })
      .mockResolvedValueOnce(effects("allow"));
    await expect(authorizeBulk(fakeApi(post), SUBJECT, ["a.read"])).rejects.toThrow();
    const map = await authorizeBulk(fakeApi(post), SUBJECT, ["a.read"]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(map.get("a.read")).toBe(true);
  });

  it("is order-independent in its cache key (same action set, any order)", async () => {
    const post = vi.fn().mockResolvedValue(effects("allow", "deny"));
    await authorizeBulk(fakeApi(post), SUBJECT, ["a.read", "a.write"]);
    await authorizeBulk(fakeApi(post), SUBJECT, ["a.write", "a.read"]);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
