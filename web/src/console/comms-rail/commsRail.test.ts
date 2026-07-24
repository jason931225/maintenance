import { describe, expect, it } from "vitest";

import {
  createCommsRailOperationApi,
  decodeMailRail,
  decodeMessengerRail,
  decodeNoticeRail,
  decodeNotificationRail,
} from "./adapters";
import type { CommsRailApi } from "./adapters";
import { commsRailGenerationFingerprint, type CommsRailGeneration } from "./model";
import { CommsRailInvalidationBus, CommsRailStore } from "./store";

const ID = "00000000-0000-4000-8000-000000000001";
const ID_TWO = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-22T00:00:00Z";
const generation: CommsRailGeneration = { key: "principal-a-org-a-branch-a", principalId: ID, organizationId: ID_TWO, branchIds: [ID_TWO] };

const messenger = { items: [{ id: ID, kind: "channel", visibility: "channel", muted: false, branch_id: ID_TWO, title: "", work_order_id: null, last_message_id: ID_TWO, last_message_at: NOW, member_count: 2, unread_count: 1, created_at: NOW, updated_at: NOW }] };
const mail = [{ id: ID, subject: "subject", last_message_at: NOW, message_count: 1, unread_count: 1, has_attachments: false, is_flagged: false }];
const notification = { items: [{ id: ID, recipient_user_id: ID_TWO, category: "approval", kind: "assigned", text: "x", link: { type: "screen", screen: "overview" }, unread: true, created_at: NOW, read_at: null, resolved_at: null }] };
const notice = { items: [{ id: ID, code: "NT-1", author_user_id: ID_TWO, title: "n", body: "b", status: "published", published_at: NOW, created_at: NOW, acknowledged: false }], limit: 50, next_cursor: null };

function api(overrides: Partial<CommsRailApi> = {}): CommsRailApi {
  return {
    listMessengerThreads: () => Promise.resolve({ status: 200, data: messenger }),
    listMailThreads: () => Promise.resolve({ status: 200, data: mail }),
    listNotifications: () => Promise.resolve({ status: 200, data: notification }),
    listNotices: () => Promise.resolve({ status: 200, data: notice }),
    markMessengerRead: () => Promise.resolve({ status: 204, data: undefined }),
    markMailRead: () => Promise.resolve({ status: 204, data: undefined }),
    markNotificationRead: () => Promise.resolve({ status: 200, data: notification.items[0] }),
    ...overrides,
  };
}

describe("comms rail generated operation adapter", () => {
  it("uses an injected existing-operation owner and honors abort", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = createCommsRailOperationApi({
      listMessengerThreads: (signal) => { receivedSignal = signal; return Promise.resolve({ status: 200, data: messenger }); },
      listMailThreads: () => Promise.resolve({ status: 200, data: mail }),
      listNotifications: () => Promise.resolve({ status: 200, data: notification }),
      listNotices: () => Promise.resolve({ status: 200, data: notice }),
    });
    const controller = new AbortController();
    expect((await client.listMessengerThreads(controller.signal)).status).toBe(200);
    expect((await client.listMailThreads(controller.signal)).status).toBe(200);
    expect((await client.listNotifications(controller.signal)).status).toBe(200);
    expect((await client.listNotices(controller.signal)).status).toBe(200);
    expect(receivedSignal).toBe(controller.signal);
  });

  it.each([
    ["messenger", () => decodeMessengerRail({ status: 200, data: messenger })],
    ["mail", () => decodeMailRail({ status: 200, data: mail })],
    ["notifications", () => decodeNotificationRail({ status: 200, data: notification })],
    ["notices", () => decodeNoticeRail({ status: 200, data: notice })],
  ])("decodes the %s source into a real typed row", (_source, decode) => {
    const result = decode();
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.items).toHaveLength(1);
  });

  it.each([
    ["messenger", decodeMessengerRail, { items: [{ id: "unsafe" }] }],
    ["mail", decodeMailRail, [{ id: "unsafe" }]],
    ["notifications", decodeNotificationRail, { items: [{ id: "unsafe" }] }],
    ["notices", decodeNoticeRail, { items: [{ id: "unsafe" }] }],
  ] as const)("has denied, malformed, and error states for %s", (_source, decode, malformed) => {
    expect(decode({ status: 403, data: undefined }).kind).toBe("denied");
    expect(decode({ status: 200, data: malformed }).kind).toBe("malformed");
    expect(decode({ status: 503, data: undefined }).kind).toBe("error");
  });

  it("omits unknown notification targets rather than exposing an inert route", () => {
    const result = decodeNotificationRail({ status: 200, data: { items: [{ ...notification.items[0], link: { type: "object", kind: "unknown", id: ID_TWO } }] } });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.items[0]?.target).toBeUndefined();
  });

  it("reuses the closed notice parser for publication semantics and cursor bounds", () => {
    expect(decodeNoticeRail({ status: 200, data: { ...notice, items: [{ ...notice.items[0], code: null }] } }).kind).toBe("malformed");
    expect(decodeNoticeRail({ status: 200, data: { ...notice, items: [{ ...notice.items[0], published_at: "2026-07-21T00:00:00Z" }] } }).kind).toBe("malformed");
    expect(decodeNoticeRail({ status: 200, data: { ...notice, items: [notice.items[0], notice.items[0]] } }).kind).toBe("malformed");
    expect(decodeNoticeRail({ status: 200, data: { ...notice, limit: 101 } }).kind).toBe("malformed");
    expect(decodeNoticeRail({ status: 200, data: { ...notice, next_cursor: "" } }).kind).toBe("malformed");
  });
});

describe("comms rail generation and reconciliation", () => {
  it("loads all sources, retries malformed data, and reconciles reads by authoritative reread", async () => {
    let notifications = { status: 200, data: { items: [{ ...notification.items[0], unread: true }] } };
    const bus = new CommsRailInvalidationBus();
    const store = new CommsRailStore(api({
      listNotifications: () => Promise.resolve(notifications),
      markNotificationRead: () => {
        notifications = { status: 200, data: { items: [{ ...notification.items[0], unread: false, read_at: NOW }] } };
        return Promise.resolve({ status: 200, data: notifications.data.items[0] });
      },
    }), bus);
    store.setGeneration(generation);
    await store.refresh();
    expect(store.getSnapshot().notifications.kind).toBe("ready");
    const ready = store.getSnapshot().notifications;
    if (ready.kind === "ready") {
      const action = ready.items[0]?.action;
      if (action) await store.act(action);
    }
    const reconciled = store.getSnapshot().notifications;
    expect(reconciled.kind).toBe("ready");
    if (reconciled.kind === "ready") expect(reconciled.items[0]?.unread).toBe(false);
    store.dispose();
  });

  it("retries only the failed source and replaces malformed state with its authoritative response", async () => {
    let attempt = 0;
    const store = new CommsRailStore(api({
      listMailThreads: () => Promise.resolve(attempt++ === 0
        ? { status: 200, data: [{ id: "malformed" }] }
        : { status: 200, data: mail }),
    }));
    store.setGeneration(generation);
    await store.refresh(["mail"]);
    expect(store.getSnapshot().mail.kind).toBe("malformed");
    await store.retry("mail");
    expect(store.getSnapshot().mail.kind).toBe("ready");
    store.dispose();
  });

  it("maps transport failures without exposing their details and preserves a 401 action denial", async () => {
    const store = new CommsRailStore(api({
      listMailThreads: () => Promise.reject(new Error("sensitive transport detail")),
      markNotificationRead: () => Promise.resolve({ status: 401, data: undefined }),
    }));
    store.setGeneration(generation);
    await store.refresh(["mail", "notifications"]);
    expect(store.getSnapshot().mail).toEqual({ kind: "error", code: "network_error" });
    const notifications = store.getSnapshot().notifications;
    if (notifications.kind !== "ready" || !notifications.items[0]?.action) throw new Error("test_setup_failed");
    await store.act(notifications.items[0].action);
    expect(store.getSnapshot().notifications).toEqual({ kind: "denied", status: 401 });
    store.dispose();
  });

  it("suppresses stale principal responses and aborts their request", async () => {
    let resolveFirst!: (response: { status: number; data: unknown }) => void;
    let aborted = false;
    const first = new Promise<{ status: number; data: unknown }>((resolve) => { resolveFirst = resolve; });
    const store = new CommsRailStore(api({
      listMessengerThreads: async (signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        return first;
      },
    }));
    store.setGeneration(generation);
    const pending = store.refresh(["messenger"]);
    // Same untrusted key, changed principal: canonical fingerprint must reset.
    store.setGeneration({ ...generation, principalId: ID_TWO });
    resolveFirst({ status: 200, data: messenger });
    await pending;
    expect(aborted).toBe(true);
    expect(store.getSnapshot().messenger.kind).toBe("loading");
    store.dispose();
  });

  it("never exposes a notice acknowledgement action during Wave 1", async () => {
    const store = new CommsRailStore(api());
    store.setGeneration(generation);
    await store.refresh(["notices"]);
    const snapshot = store.getSnapshot().notices;
    expect(snapshot.kind).toBe("ready");
    if (snapshot.kind === "ready") expect(snapshot.items[0]?.action).toBeUndefined();
    store.dispose();
  });

  it("normalizes branch order and excludes muted messenger unread from parity", () => {
    expect(commsRailGenerationFingerprint({ ...generation, branchIds: [ID, ID_TWO, ID] }))
      .toBe(commsRailGenerationFingerprint({ ...generation, branchIds: [ID_TWO, ID] }));
    const result = decodeMessengerRail({ status: 200, data: { items: [{ ...messenger.items[0], muted: true }] } });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.items[0]?.unread).toBe(true);
      expect(result.items[0]?.action).toBeUndefined();
    }
  });

  it("aborts an in-flight action when the principal generation changes", async () => {
    let aborted = false;
    let rejectAction!: (reason: unknown) => void;
    const pendingAction = new Promise<{ status: number; data: unknown }>((_resolve, reject) => { rejectAction = reject; });
    const store = new CommsRailStore(api({
      markNotificationRead: (_id, signal) => {
        signal.addEventListener("abort", () => { aborted = true; rejectAction(new DOMException("Aborted", "AbortError")); });
        return pendingAction;
      },
    }));
    store.setGeneration(generation);
    await store.refresh(["notifications"]);
    const snapshot = store.getSnapshot().notifications;
    if (snapshot.kind !== "ready" || !snapshot.items[0]?.action) throw new Error("test_setup_failed");
    const actionPromise = store.act(snapshot.items[0].action);
    store.setGeneration({ ...generation, principalId: ID_TWO });
    await expect(actionPromise).resolves.toBe("aborted");
    expect(aborted).toBe(true);
    store.dispose();
  });

  it("discards AbortError actions on dispose and maps a rejected action to a redacted error", async () => {
    let rejectAction!: (reason: unknown) => void;
    const pendingAction = new Promise<{ status: number; data: unknown }>((_resolve, reject) => { rejectAction = reject; });
    const store = new CommsRailStore(api({
      markNotificationRead: (_id, signal) => {
        signal.addEventListener("abort", () => { rejectAction(new DOMException("Aborted", "AbortError")); });
        return pendingAction;
      },
    }));
    store.setGeneration(generation);
    await store.refresh(["notifications"]);
    const snapshot = store.getSnapshot().notifications;
    if (snapshot.kind !== "ready" || !snapshot.items[0]?.action) throw new Error("test_setup_failed");
    const pending = store.act(snapshot.items[0].action);
    store.dispose();
    await expect(pending).resolves.toBe("aborted");

    const failureStore = new CommsRailStore(api({ markNotificationRead: () => Promise.reject(new Error("sensitive rejection")) }));
    failureStore.setGeneration(generation);
    await failureStore.refresh(["notifications"]);
    const failed = failureStore.getSnapshot().notifications;
    if (failed.kind !== "ready" || !failed.items[0]?.action) throw new Error("test_setup_failed");
    await expect(failureStore.act(failed.items[0].action)).resolves.toBe("error");
    failureStore.dispose();
  });
});

