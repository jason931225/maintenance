import { act, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession, ViewAsState } from "../../context/auth";
import type { OntObjectTypeDef } from "./types";
import {
  ontologyRevisionTransportCircuitOpenForTests,
  ontologyRevisionAuthorityKey,
  ontologyRevisionTransportFenceCountForTests,
  ontologyWorkspaceAuthorityKey,
  resetOntologyRevisionTransportStateForTests,
  useOntologyRevisionCommitQueue,
} from "./useOntologyRevisionCommitQueue";
import type {
  ObjectTypeWriteVersion,
  OntologyRevisionPersistReceipt,
} from "./useOntologyRevisionCommitQueue";
import * as commitQueueModule from "./useOntologyRevisionCommitQueue";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(id: string, title: string): OntObjectTypeDef {
  return {
    id,
    stableKey: id,
    code: id,
    title: id,
    backingKind: "instance",
    schemaVersion: 1,
    lifecycleState: "draft",
    keyWriteRevision: 7,
    keyWriteEtag: '"ont-object-type-key:00000000000000000000000000000001:r7"',
    properties: [{ key: title, title, type: "text", required: false }],
    links: [],
    actions: [],
    analytics: [],
    instances: [],
    acting: [],
  };
}

function writeVersion(revision: number): ObjectTypeWriteVersion {
  return {
    etag: `"ont-object-type-key:00000000000000000000000000000001:r${String(revision)}"`,
    keyWriteRevision: revision,
  };
}

function LayoutCommitter({
  authorityKey,
  emit,
  persist,
  reload,
  title,
  onPromise,
}: {
  authorityKey: string;
  emit: boolean;
  persist: (value: OntObjectTypeDef) => Promise<void>;
  reload: () => Promise<void>;
  title: string;
  onPromise: (promise: Promise<void>) => void;
}) {
  const commit = useOntologyRevisionCommitQueue({
    authorityKey,
    persist,
    reload,
  });
  useLayoutEffect(() => {
    if (emit) onPromise(commit(snapshot("type-a", title)));
  }, [commit, emit, onPromise, title]);
  return null;
}

interface DescendantLayoutDispatch {
  label: string;
  retained: boolean;
  typeId: string;
  title: string;
}

function RetainedDescendantLayoutCommitter({
  commit,
  dispatches,
  onPromise,
}: {
  commit: (value: OntObjectTypeDef) => Promise<void>;
  dispatches: DescendantLayoutDispatch[];
  onPromise: (label: string, promise: Promise<void>) => void;
}) {
  const initialCommit = useRef(commit);
  useLayoutEffect(() => {
    for (const dispatch of dispatches) {
      const selectedCommit = dispatch.retained ? initialCommit.current : commit;
      onPromise(
        dispatch.label,
        selectedCommit(snapshot(dispatch.typeId, dispatch.title)),
      );
    }
  }, [commit, dispatches, onPromise]);
  return null;
}

function QueueWithRetainedDescendant({
  authorityKey,
  persist,
  reload,
  dispatches,
  onPromise,
}: {
  authorityKey: string;
  persist: (value: OntObjectTypeDef) => Promise<void>;
  reload: () => Promise<void>;
  dispatches: DescendantLayoutDispatch[];
  onPromise: (label: string, promise: Promise<void>) => void;
}) {
  const commit = useOntologyRevisionCommitQueue({
    authorityKey,
    persist,
    reload,
  });
  return (
    <RetainedDescendantLayoutCommitter
      commit={commit}
      dispatches={dispatches}
      onPromise={onPromise}
    />
  );
}

describe("useOntologyRevisionCommitQueue", () => {
  beforeEach(() => {
    resetOntologyRevisionTransportStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetOntologyRevisionTransportStateForTests();
  });
  it("keys tenant, user, and view-as authority without access tokens", () => {
    const sessionA: AuthSession = {
      access_token: "token-a",
      client_session_incarnation: "session-a",
      org_id: "tenant-1",
      user_id: "user-1",
      branches: ["branch-a"],
    };
    const sessionB = { ...sessionA, access_token: "token-b" };
    expect(ontologyRevisionAuthorityKey(sessionA, undefined)).toBe(
      ontologyRevisionAuthorityKey(sessionB, undefined),
    );

    const viewAs: ViewAsState = {
      token: "view-token",
      client_session_incarnation: "view-session",
      actingOrgId: "tenant-2",
      actingOrgName: "Tenant Two",
      actingRole: "ADMIN",
      mode: "MANAGE",
      source: "PLATFORM",
      platformSession: sessionA,
    };
    expect(ontologyRevisionAuthorityKey(sessionA, viewAs)).not.toBe(
      ontologyRevisionAuthorityKey(sessionA, undefined),
    );
    expect(ontologyRevisionAuthorityKey(sessionA, viewAs)).not.toBe(
      ontologyRevisionAuthorityKey(sessionA, { ...viewAs, mode: "VIEW_ONLY" }),
    );
    expect(ontologyRevisionAuthorityKey(sessionA, viewAs)).toBe(
      ontologyRevisionAuthorityKey(sessionB, {
        ...viewAs,
        token: "refreshed-view-token",
        platformSession: sessionB,
      }),
    );
  });

  it("partitions writable authority by effective and view-as source session incarnation", () => {
    const sessionA: AuthSession = {
      access_token: "token-a",
      client_session_incarnation: "session-a",
      org_id: "tenant-1",
      user_id: "user-1",
      roles: ["ADMIN"],
      branches: ["branch-a"],
    };
    const sessionB: AuthSession = {
      ...sessionA,
      access_token: "token-b",
      client_session_incarnation: "session-b",
    };
    expect(ontologyRevisionAuthorityKey(sessionA, undefined)).not.toBe(
      ontologyRevisionAuthorityKey(sessionB, undefined),
    );
    expect(ontologyRevisionAuthorityKey(sessionA, undefined)).toBe(
      ontologyRevisionAuthorityKey(
        {
          ...sessionA,
          access_token: "rotated-token",
          roles: ["ADMIN", "ADMIN"],
          branches: ["branch-a", "branch-a"],
        },
        undefined,
      ),
    );

    const effective: AuthSession = {
      ...sessionA,
      access_token: "view-token",
      client_session_incarnation: "view-session",
      org_id: "tenant-2",
    };
    const viewAs: ViewAsState = {
      token: "view-token",
      client_session_incarnation: "view-session",
      actingOrgId: "tenant-2",
      actingOrgName: "Tenant Two",
      actingRole: "ADMIN",
      mode: "MANAGE",
      source: "PLATFORM",
      platformSession: sessionA,
    };
    expect(ontologyRevisionAuthorityKey(effective, viewAs)).not.toBe(
      ontologyRevisionAuthorityKey(effective, {
        ...viewAs,
        platformSession: {
          ...sessionA,
          client_session_incarnation: "source-session-b",
        },
      }),
    );

    expect(() =>
      ontologyRevisionAuthorityKey(
        {
          access_token: "no-incarnation",
          org_id: "tenant-1",
          user_id: "user-1",
          roles: ["ADMIN"],
        },
        undefined,
      ),
    ).toThrow(/incarnation/i);
    expect(() =>
      ontologyRevisionAuthorityKey(
        { ...effective, client_session_incarnation: undefined },
        viewAs,
      ),
    ).toThrow(/incarnation/i);
    expect(() =>
      ontologyRevisionAuthorityKey(effective, {
        ...viewAs,
        platformSession: {
          ...sessionA,
          client_session_incarnation: undefined,
        },
      }),
    ).toThrow(/incarnation/i);
  });

  it("keys every normalized write-relevant claim while excluding token material", () => {
    const base: AuthSession = {
      access_token: "token-a",
      client_session_incarnation: "session-a",
      org_id: "tenant-1",
      user_id: "user-1",
      roles: ["EDITOR", "ADMIN"],
      group_roles: ["GROUP_ADMIN", "GROUP_AUDITOR"],
      feature_grants: ["ontology_write", "ontology_read"],
      branches: ["branch-b", "branch-a", "branch-a"],
      isPlatform: false,
    };
    const reordered: AuthSession = {
      ...base,
      access_token: "token-b",
      roles: ["ADMIN", "EDITOR"],
      group_roles: ["GROUP_AUDITOR", "GROUP_ADMIN"],
      feature_grants: ["ontology_read", "ontology_write"],
      branches: ["branch-a", "branch-b"],
    };
    expect(ontologyRevisionAuthorityKey(base, undefined)).toBe(
      ontologyRevisionAuthorityKey(reordered, undefined),
    );
    expect(ontologyRevisionAuthorityKey(base, undefined)).not.toBe(
      ontologyRevisionAuthorityKey({ ...base, roles: ["ADMIN"] }, undefined),
    );
    expect(ontologyRevisionAuthorityKey(base, undefined)).not.toBe(
      ontologyRevisionAuthorityKey({ ...base, group_roles: [] }, undefined),
    );
    expect(ontologyRevisionAuthorityKey(base, undefined)).not.toBe(
      ontologyRevisionAuthorityKey(
        { ...base, feature_grants: ["ontology_read"] },
        undefined,
      ),
    );
    expect(ontologyRevisionAuthorityKey(base, undefined)).not.toBe(
      ontologyRevisionAuthorityKey({ ...base, isPlatform: true }, undefined),
    );
  });

  it("changes the authority key when effective branch membership changes", () => {
    const base: AuthSession = {
      access_token: "token-a",
      client_session_incarnation: "session-a",
      org_id: "tenant-1",
      user_id: "user-1",
      roles: ["ADMIN"],
      branches: ["branch-a"],
    };

    expect(ontologyRevisionAuthorityKey(base, undefined)).not.toBe(
      ontologyRevisionAuthorityKey(
        { ...base, branches: ["branch-b"] },
        undefined,
      ),
    );
  });

  it("normalizes view-as source branch membership in the authority key", () => {
    const source: AuthSession = {
      access_token: "source-token",
      client_session_incarnation: "source-session",
      org_id: "platform-org",
      user_id: "operator-1",
      roles: ["SUPER_ADMIN"],
      branches: ["branch-b", "branch-a", "branch-a"],
      isPlatform: true,
    };
    const active: AuthSession = {
      access_token: "view-token",
      client_session_incarnation: "view-session",
      org_id: "tenant-1",
      user_id: "operator-1",
      roles: ["ADMIN"],
      branches: ["tenant-branch"],
    };
    const viewAs: ViewAsState = {
      token: "view-token",
      actingOrgId: "tenant-1",
      actingOrgName: "Tenant One",
      actingRole: "ADMIN",
      mode: "MANAGE",
      source: "PLATFORM",
      platformSession: source,
    };

    expect(ontologyRevisionAuthorityKey(active, viewAs)).toBe(
      ontologyRevisionAuthorityKey(active, {
        ...viewAs,
        platformSession: { ...source, branches: ["branch-a", "branch-b"] },
      }),
    );
  });

  it("changes the authority key when view-as source branch membership changes", () => {
    const source: AuthSession = {
      access_token: "source-token",
      client_session_incarnation: "source-session",
      org_id: "platform-org",
      user_id: "operator-1",
      roles: ["SUPER_ADMIN"],
      branches: ["branch-a"],
      isPlatform: true,
    };
    const active: AuthSession = {
      access_token: "view-token",
      client_session_incarnation: "view-session",
      org_id: "tenant-1",
      user_id: "operator-1",
      roles: ["ADMIN"],
      branches: ["tenant-branch"],
    };
    const viewAs: ViewAsState = {
      token: "view-token",
      actingOrgId: "tenant-1",
      actingOrgName: "Tenant One",
      actingRole: "ADMIN",
      mode: "MANAGE",
      source: "PLATFORM",
      platformSession: source,
    };

    expect(ontologyRevisionAuthorityKey(active, viewAs)).not.toBe(
      ontologyRevisionAuthorityKey(active, {
        ...viewAs,
        platformSession: { ...source, branches: ["branch-b"] },
      }),
    );
  });

  it("includes explicit view-as source identity and fails closed without stable writable identity", () => {
    const source: AuthSession = {
      access_token: "source-token",
      client_session_incarnation: "source-session",
      org_id: "platform-org",
      user_id: "operator-1",
      roles: ["SUPER_ADMIN"],
      isPlatform: true,
    };
    const active: AuthSession = {
      access_token: "view-token",
      client_session_incarnation: "view-session",
      org_id: "tenant-1",
      user_id: "operator-1",
      roles: ["ADMIN"],
    };
    const viewAs: ViewAsState = {
      token: "view-token",
      actingOrgId: "tenant-1",
      actingOrgName: "Tenant One",
      actingRole: "ADMIN",
      mode: "MANAGE",
      source: "PLATFORM",
      platformSession: source,
    };
    expect(ontologyRevisionAuthorityKey(active, viewAs)).not.toBe(
      ontologyRevisionAuthorityKey(active, {
        ...viewAs,
        platformSession: { ...source, user_id: "operator-2" },
      }),
    );
    expect(() =>
      ontologyRevisionAuthorityKey(
        {
          access_token: "missing-user",
          client_session_incarnation: "session-missing-user",
          org_id: "tenant-1",
          roles: ["ADMIN"],
        },
        undefined,
      ),
    ).toThrow(/stable.*user/i);
    expect(() =>
      ontologyRevisionAuthorityKey(
        {
          access_token: "missing-org",
          client_session_incarnation: "session-missing-org",
          user_id: "user-1",
          roles: ["ADMIN"],
        },
        undefined,
      ),
    ).toThrow(/stable.*org/i);
  });

  it("isolates a same-authority remount from old in-flight and queued work", async () => {
    const oldFirst = deferred<undefined>();
    const oldPersist = vi.fn().mockImplementationOnce(() => oldFirst.promise);
    const oldReload = vi.fn().mockResolvedValue(undefined);
    const oldHost = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-1|user-1||||",
        persist: oldPersist,
        reload: oldReload,
      }),
    );

    const oldRunning = oldHost.result.current(snapshot("type-a", "E1"));
    const oldQueued = oldHost.result.current(snapshot("type-a", "E2"));
    void oldRunning.catch(() => undefined);
    void oldQueued.catch(() => undefined);
    expect(oldPersist).toHaveBeenCalledTimes(1);
    oldHost.unmount();

    const newFirst = deferred<undefined>();
    const newPersist = vi.fn().mockImplementationOnce(() => newFirst.promise);
    const newReload = vi.fn().mockResolvedValue(undefined);
    const newHost = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-1|user-1||||",
        persist: newPersist,
        reload: newReload,
      }),
    );
    const newRequest = newHost.result.current(snapshot("type-a", "NEW"));
    void newRequest.catch(() => undefined);
    expect(newPersist).not.toHaveBeenCalled();

    await act(async () => {
      oldFirst.resolve(undefined);
      await oldFirst.promise;
    });
    await waitFor(() => {
      expect(newPersist).toHaveBeenCalledTimes(1);
    });
    await expect(oldRunning).rejects.toThrow("invalidated");
    await expect(oldQueued).rejects.toThrow("invalidated");
    expect(oldPersist).toHaveBeenCalledTimes(1);
    expect(oldReload).not.toHaveBeenCalled();

    await act(async () => {
      newFirst.resolve(undefined);
      await newFirst.promise;
    });
    await expect(newRequest).resolves.toBeUndefined();
    expect(newReload).toHaveBeenCalledTimes(1);
    newHost.unmount();
  });

  it.each([
    ["old settles after new intent", true],
    ["old settles before the new transport", false],
  ])(
    "serializes same-authority remount/equal-claim replacement over shared persisted state when %s",
    async (_label, resolveNewBeforeOld) => {
      const authorityKey = "same-authority-remount";
      const oldTransport = deferred<undefined>();
      const newTransport = deferred<undefined>();
      const persisted = new Map<
        string,
        OntObjectTypeDef["properties"][number]
      >();
      let activeSameTypeTransports = 0;
      let maximumSameTypeTransports = 0;

      const persistAfter = (
        transport: ReturnType<typeof deferred<undefined>>,
      ) =>
        vi.fn(async (value: OntObjectTypeDef) => {
          activeSameTypeTransports += 1;
          maximumSameTypeTransports = Math.max(
            maximumSameTypeTransports,
            activeSameTypeTransports,
          );
          try {
            await transport.promise;
            for (const property of value.properties) {
              const existing = persisted.get(property.key);
              if (existing && existing.title !== property.title) {
                throw new Error("divergent child identity reuse");
              }
              persisted.set(property.key, property);
            }
          } finally {
            activeSameTypeTransports -= 1;
          }
        });

      const oldPersist = persistAfter(oldTransport);
      const oldReload = vi.fn().mockResolvedValue(undefined);
      const oldHost = renderHook(() =>
        useOntologyRevisionCommitQueue({
          authorityKey,
          persist: oldPersist,
          reload: oldReload,
        }),
      );
      const oldRequest = oldHost.result.current(snapshot("type-a", "old-edit"));
      void oldRequest.catch(() => undefined);
      oldHost.unmount();

      if (resolveNewBeforeOld) newTransport.resolve(undefined);
      const newPersist = persistAfter(newTransport);
      const newReload = vi.fn().mockResolvedValue(undefined);
      const replacementHost = renderHook(() =>
        useOntologyRevisionCommitQueue({
          authorityKey,
          persist: newPersist,
          reload: newReload,
        }),
      );
      const newRequest = replacementHost.result.current(
        snapshot("type-a", "new-edit"),
      );

      expect(oldPersist).toHaveBeenCalledTimes(1);
      expect(newPersist).not.toHaveBeenCalled();
      expect(maximumSameTypeTransports).toBe(1);

      await act(async () => {
        oldTransport.resolve(undefined);
        await oldTransport.promise;
      });
      await waitFor(() => {
        expect(newPersist).toHaveBeenCalledTimes(1);
      });
      if (!resolveNewBeforeOld) {
        await act(async () => {
          newTransport.resolve(undefined);
          await newTransport.promise;
        });
      }
      await expect(oldRequest).rejects.toThrow("invalidated");
      await expect(newRequest).resolves.toBeUndefined();
      expect([...persisted.keys()].sort()).toEqual(["new-edit", "old-edit"]);
      expect(maximumSameTypeTransports).toBe(1);
      expect(oldReload).not.toHaveBeenCalled();
      expect(newReload).toHaveBeenCalledTimes(1);

      replacementHost.unmount();
      await waitFor(() => {
        const probe = (
          commitQueueModule as unknown as {
            ontologyRevisionTransportFenceCountForTests?: () => number;
          }
        ).ontologyRevisionTransportFenceCountForTests;
        expect(probe).toBeTypeOf("function");
        expect(probe?.()).toBe(0);
      });
    },
  );

  it("keeps different type and different authority transports concurrent", async () => {
    const aTypeOne = deferred<undefined>();
    const aTypeTwo = deferred<undefined>();
    const bTypeOne = deferred<undefined>();
    const persistA = vi
      .fn<(value: OntObjectTypeDef) => Promise<void>>()
      .mockImplementationOnce(() => aTypeOne.promise)
      .mockImplementationOnce(() => aTypeTwo.promise);
    const persistB = vi.fn().mockImplementationOnce(() => bTypeOne.promise);
    const hostA = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "authority-a",
        persist: persistA,
        reload: vi.fn().mockResolvedValue(undefined),
      }),
    );
    const hostB = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "authority-b",
        persist: persistB,
        reload: vi.fn().mockResolvedValue(undefined),
      }),
    );

    const requests = [
      hostA.result.current(snapshot("type-one", "a-one")),
      hostA.result.current(snapshot("type-two", "a-two")),
      hostB.result.current(snapshot("type-one", "b-one")),
    ];
    expect(persistA).toHaveBeenCalledTimes(2);
    expect(persistB).toHaveBeenCalledTimes(1);

    await act(async () => {
      aTypeOne.resolve(undefined);
      aTypeTwo.resolve(undefined);
      bTypeOne.resolve(undefined);
      await Promise.all([aTypeOne.promise, aTypeTwo.promise, bTypeOne.promise]);
    });
    await expect(Promise.all(requests)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    hostA.unmount();
    hostB.unmount();
  });

  it("invalidates queued work on an authority change and starts new authority work immediately", async () => {
    const oldFirst = deferred<undefined>();
    const newFirst = deferred<undefined>();
    const oldPersist = vi.fn().mockImplementationOnce(() => oldFirst.promise);
    const newPersist = vi.fn().mockImplementationOnce(() => newFirst.promise);
    const oldReload = vi.fn().mockResolvedValue(undefined);
    const newReload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      ({ authorityKey, persist, reload }) =>
        useOntologyRevisionCommitQueue({ authorityKey, persist, reload }),
      {
        initialProps: {
          authorityKey: "tenant-1|user-1||||",
          persist: oldPersist,
          reload: oldReload,
        },
      },
    );

    const oldRunning = hook.result.current(snapshot("type-a", "OLD-1"));
    const oldQueued = hook.result.current(snapshot("type-a", "OLD-2"));
    void oldRunning.catch(() => undefined);
    void oldQueued.catch(() => undefined);
    hook.rerender({
      authorityKey: "tenant-2|user-1|tenant-2|ADMIN|MANAGE|PLATFORM",
      persist: newPersist,
      reload: newReload,
    });
    const newRequest = hook.result.current(snapshot("type-a", "NEW-1"));
    expect(newPersist).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldFirst.resolve(undefined);
      await oldFirst.promise;
    });
    await expect(oldRunning).rejects.toThrow("invalidated");
    await expect(oldQueued).rejects.toThrow("invalidated");
    expect(oldPersist).toHaveBeenCalledTimes(1);
    expect(oldReload).not.toHaveBeenCalled();

    await act(async () => {
      newFirst.resolve(undefined);
      await newFirst.promise;
    });
    await expect(newRequest).resolves.toBeUndefined();
    expect(newReload).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("rejects a retained older-authority closure without disturbing current work in StrictMode", async () => {
    const currentTransport = deferred<undefined>();
    const oldPersist = vi.fn().mockResolvedValue(undefined);
    const currentPersist = vi
      .fn()
      .mockImplementation(() => currentTransport.promise);
    const oldReload = vi.fn().mockResolvedValue(undefined);
    const currentReload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      ({ authorityKey, persist, reload }) =>
        useOntologyRevisionCommitQueue({ authorityKey, persist, reload }),
      {
        initialProps: {
          authorityKey: "authority-a",
          persist: oldPersist,
          reload: oldReload,
        },
        wrapper: StrictMode,
      },
    );
    const retainedAuthorityACommit = hook.result.current;

    hook.rerender({
      authorityKey: "authority-b",
      persist: currentPersist,
      reload: currentReload,
    });
    const currentRequest = hook.result.current(snapshot("type-a", "B1"));
    void currentRequest.catch(() => undefined);
    const staleRequest = retainedAuthorityACommit(snapshot("type-b", "A2"));
    void staleRequest.catch(() => undefined);

    await expect(staleRequest).rejects.toThrow("invalidated");
    expect(oldPersist).not.toHaveBeenCalled();
    expect(oldReload).not.toHaveBeenCalled();
    expect(currentPersist).toHaveBeenCalledTimes(1);

    await act(async () => {
      currentTransport.resolve(undefined);
      await currentTransport.promise;
    });
    await expect(currentRequest).resolves.toBeUndefined();
    expect(currentReload).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("routes a retained same-authority closure through the latest committed callbacks", async () => {
    const currentTransport = deferred<undefined>();
    const oldPersist = vi.fn().mockResolvedValue(undefined);
    const currentPersist = vi
      .fn()
      .mockImplementation(() => currentTransport.promise);
    const oldReload = vi.fn().mockResolvedValue(undefined);
    const currentReload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      ({ persist, reload }) =>
        useOntologyRevisionCommitQueue({
          authorityKey: "same-authority",
          persist,
          reload,
        }),
      { initialProps: { persist: oldPersist, reload: oldReload } },
    );
    const retainedCommit = hook.result.current;

    hook.rerender({ persist: currentPersist, reload: currentReload });
    const request = retainedCommit(snapshot("type-a", "LATEST"));

    expect(oldPersist).not.toHaveBeenCalled();
    expect(currentPersist).toHaveBeenCalledWith(
      snapshot("type-a", "LATEST"),
      expect.any(Object),
    );
    await act(async () => {
      currentTransport.resolve(undefined);
      await currentTransport.promise;
    });
    await expect(request).resolves.toBeUndefined();
    expect(oldReload).not.toHaveBeenCalled();
    expect(currentReload).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("rejects a retained A closure after authority cycles from A to B to A", async () => {
    const currentTransport = deferred<undefined>();
    const initialPersist = vi.fn().mockResolvedValue(undefined);
    const middlePersist = vi.fn().mockResolvedValue(undefined);
    const currentPersist = vi
      .fn()
      .mockImplementation(() => currentTransport.promise);
    const initialReload = vi.fn().mockResolvedValue(undefined);
    const middleReload = vi.fn().mockResolvedValue(undefined);
    const currentReload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      ({ authorityKey, persist, reload }) =>
        useOntologyRevisionCommitQueue({ authorityKey, persist, reload }),
      {
        initialProps: {
          authorityKey: "authority-a",
          persist: initialPersist,
          reload: initialReload,
        },
        wrapper: StrictMode,
      },
    );
    const retainedInitialACommit = hook.result.current;

    hook.rerender({
      authorityKey: "authority-b",
      persist: middlePersist,
      reload: middleReload,
    });
    hook.rerender({
      authorityKey: "authority-a",
      persist: currentPersist,
      reload: currentReload,
    });
    const currentRequest = hook.result.current(snapshot("type-a", "A3"));
    void currentRequest.catch(() => undefined);
    const staleRequest = retainedInitialACommit(snapshot("type-b", "A1-stale"));
    void staleRequest.catch(() => undefined);

    await expect(staleRequest).rejects.toThrow("invalidated");
    expect(initialPersist).not.toHaveBeenCalled();
    expect(middlePersist).not.toHaveBeenCalled();
    expect(currentPersist).toHaveBeenCalledWith(
      snapshot("type-a", "A3"),
      expect.any(Object),
    );

    await act(async () => {
      currentTransport.resolve(undefined);
      await currentTransport.promise;
    });
    await expect(currentRequest).resolves.toBeUndefined();
    expect(initialReload).not.toHaveBeenCalled();
    expect(middleReload).not.toHaveBeenCalled();
    expect(currentReload).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("rejects a retained closure invoked after unmount without side effects", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "authority-a",
        persist,
        reload,
      }),
    );
    const retainedCommit = hook.result.current;

    hook.unmount();
    const staleRequest = retainedCommit(snapshot("type-a", "AFTER-UNMOUNT"));
    void staleRequest.catch(() => undefined);

    await expect(staleRequest).rejects.toThrow("invalidated");
    expect(persist).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("blocks retained A from a descendant B layout effect while preserving B work", async () => {
    const oldTransport = deferred<undefined>();
    const currentTransport = deferred<undefined>();
    const oldPersist = vi.fn().mockImplementation(() => oldTransport.promise);
    const currentPersist = vi
      .fn()
      .mockImplementation(() => currentTransport.promise);
    const oldReload = vi.fn().mockResolvedValue(undefined);
    const currentReload = vi.fn().mockResolvedValue(undefined);
    const promises = new Map<string, Promise<void>>();
    const onPromise = (label: string, promise: Promise<void>) => {
      promises.set(label, promise);
      void promise.catch(() => undefined);
    };
    const view = render(
      <QueueWithRetainedDescendant
        authorityKey="authority-a"
        persist={oldPersist}
        reload={oldReload}
        dispatches={[]}
        onPromise={onPromise}
      />,
    );

    view.rerender(
      <QueueWithRetainedDescendant
        authorityKey="authority-b"
        persist={currentPersist}
        reload={currentReload}
        dispatches={[
          {
            label: "retained-a",
            retained: true,
            typeId: "type-a-stale",
            title: "A-stale",
          },
          {
            label: "current-b",
            retained: false,
            typeId: "type-b-current",
            title: "B-current",
          },
        ]}
        onPromise={onPromise}
      />,
    );

    await expect(promises.get("retained-a")).rejects.toThrow("invalidated");
    expect(oldPersist).not.toHaveBeenCalled();
    expect(currentPersist).toHaveBeenCalledWith(
      snapshot("type-b-current", "B-current"),
      expect.any(Object),
    );

    await act(async () => {
      oldTransport.resolve(undefined);
      currentTransport.resolve(undefined);
      await Promise.all([oldTransport.promise, currentTransport.promise]);
    });
    await expect(promises.get("current-b")).resolves.toBeUndefined();
    expect(oldReload).not.toHaveBeenCalled();
    expect(currentReload).toHaveBeenCalledTimes(1);
  });

  it("settles every StrictMode layout-effect commit without replay-only invalidation", async () => {
    const firstTransport = deferred<undefined>();
    const replayTransport = deferred<undefined>();
    const persist = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstTransport.promise)
      .mockImplementationOnce(() => replayTransport.promise);
    const reload = vi.fn().mockResolvedValue(undefined);
    const promises: Promise<void>[] = [];
    const onPromise = (promise: Promise<void>) => {
      promises.push(promise);
      void promise.catch(() => undefined);
    };

    const view = render(
      <StrictMode>
        <LayoutCommitter
          authorityKey="authority-a"
          emit
          persist={persist}
          reload={reload}
          title="strict-layout"
          onPromise={onPromise}
        />
      </StrictMode>,
    );

    expect(promises).toHaveLength(2);
    expect(persist).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstTransport.resolve(undefined);
      await firstTransport.promise;
    });
    expect(persist).toHaveBeenCalledTimes(2);
    await act(async () => {
      replayTransport.resolve(undefined);
      await replayTransport.promise;
    });
    await expect(Promise.all(promises)).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("keeps an initial A closure stale through descendant A-to-B-to-A layout commits", async () => {
    const middleTransport = deferred<undefined>();
    const currentTransport = deferred<undefined>();
    const initialPersist = vi.fn().mockResolvedValue(undefined);
    const middlePersist = vi
      .fn()
      .mockImplementation(() => middleTransport.promise);
    const currentPersist = vi
      .fn()
      .mockImplementation(() => currentTransport.promise);
    const initialReload = vi.fn().mockResolvedValue(undefined);
    const middleReload = vi.fn().mockResolvedValue(undefined);
    const currentReload = vi.fn().mockResolvedValue(undefined);
    const promises = new Map<string, Promise<void>>();
    const onPromise = (label: string, promise: Promise<void>) => {
      promises.set(label, promise);
      void promise.catch(() => undefined);
    };
    const view = render(
      <QueueWithRetainedDescendant
        authorityKey="authority-a"
        persist={initialPersist}
        reload={initialReload}
        dispatches={[]}
        onPromise={onPromise}
      />,
    );

    view.rerender(
      <QueueWithRetainedDescendant
        authorityKey="authority-b"
        persist={middlePersist}
        reload={middleReload}
        dispatches={[
          {
            label: "retained-a-during-b",
            retained: true,
            typeId: "type-a-stale-b",
            title: "A-stale-during-B",
          },
          {
            label: "current-b",
            retained: false,
            typeId: "type-b-current",
            title: "B-current",
          },
        ]}
        onPromise={onPromise}
      />,
    );
    view.rerender(
      <QueueWithRetainedDescendant
        authorityKey="authority-a"
        persist={currentPersist}
        reload={currentReload}
        dispatches={[
          {
            label: "retained-initial-a-after-cycle",
            retained: true,
            typeId: "type-a-stale-cycle",
            title: "A-initial-stale",
          },
          {
            label: "current-a",
            retained: false,
            typeId: "type-a-current",
            title: "A-current",
          },
        ]}
        onPromise={onPromise}
      />,
    );

    await expect(promises.get("retained-a-during-b")).rejects.toThrow(
      "invalidated",
    );
    await expect(promises.get("current-b")).rejects.toThrow("invalidated");
    await expect(
      promises.get("retained-initial-a-after-cycle"),
    ).rejects.toThrow("invalidated");
    expect(initialPersist).not.toHaveBeenCalled();
    expect(middlePersist).toHaveBeenCalledWith(
      snapshot("type-b-current", "B-current"),
      expect.any(Object),
    );
    expect(currentPersist).toHaveBeenCalledWith(
      snapshot("type-a-current", "A-current"),
      expect.any(Object),
    );

    await act(async () => {
      middleTransport.resolve(undefined);
      currentTransport.resolve(undefined);
      await Promise.all([middleTransport.promise, currentTransport.promise]);
    });
    await expect(promises.get("current-a")).resolves.toBeUndefined();
    expect(initialReload).not.toHaveBeenCalled();
    expect(middleReload).not.toHaveBeenCalled();
    expect(currentReload).toHaveBeenCalledTimes(1);
  });

  it("routes retained descendant work through rotated same-authority callbacks without invalidating in-flight work", async () => {
    const inFlightTransport = deferred<undefined>();
    const rotatedTransport = deferred<undefined>();
    const originalPersist = vi
      .fn<(value: OntObjectTypeDef) => Promise<void>>()
      .mockImplementation((value) =>
        value.id === "type-a-running"
          ? inFlightTransport.promise
          : Promise.resolve(undefined),
      );
    const rotatedPersist = vi
      .fn()
      .mockImplementation(() => rotatedTransport.promise);
    const originalReload = vi.fn().mockResolvedValue(undefined);
    const rotatedReload = vi.fn().mockResolvedValue(undefined);
    const promises = new Map<string, Promise<void>>();
    const onPromise = (label: string, promise: Promise<void>) => {
      promises.set(label, promise);
      void promise.catch(() => undefined);
    };
    const view = render(
      <QueueWithRetainedDescendant
        authorityKey="same-authority"
        persist={originalPersist}
        reload={originalReload}
        dispatches={[
          {
            label: "in-flight",
            retained: false,
            typeId: "type-a-running",
            title: "A-running",
          },
        ]}
        onPromise={onPromise}
      />,
    );

    view.rerender(
      <QueueWithRetainedDescendant
        authorityKey="same-authority"
        persist={rotatedPersist}
        reload={rotatedReload}
        dispatches={[
          {
            label: "retained-after-rotation",
            retained: true,
            typeId: "type-b-rotated",
            title: "B-rotated",
          },
        ]}
        onPromise={onPromise}
      />,
    );

    expect(originalPersist).toHaveBeenCalledTimes(1);
    expect(rotatedPersist).toHaveBeenCalledWith(
      snapshot("type-b-rotated", "B-rotated"),
      expect.any(Object),
    );
    await act(async () => {
      inFlightTransport.resolve(undefined);
      rotatedTransport.resolve(undefined);
      await Promise.all([inFlightTransport.promise, rotatedTransport.promise]);
    });
    await expect(promises.get("in-flight")).resolves.toBeUndefined();
    await expect(
      promises.get("retained-after-rotation"),
    ).resolves.toBeUndefined();
    expect(originalReload).not.toHaveBeenCalled();
    expect(rotatedReload).toHaveBeenCalledTimes(1);
  });

  it("uses B authority callbacks for a child layout commit during an A-to-B rerender", async () => {
    const oldTransport = deferred<undefined>();
    const newTransport = deferred<undefined>();
    const oldPersist = vi.fn().mockImplementation(() => oldTransport.promise);
    const newPersist = vi.fn().mockImplementation(() => newTransport.promise);
    const oldReload = vi.fn().mockResolvedValue(undefined);
    const newReload = vi.fn().mockResolvedValue(undefined);
    const promises: Promise<void>[] = [];
    const onPromise = (promise: Promise<void>) => {
      promises.push(promise);
      void promise.catch(() => undefined);
    };
    const view = render(
      <LayoutCommitter
        authorityKey="authority-a"
        emit
        persist={oldPersist}
        reload={oldReload}
        title="A1"
        onPromise={onPromise}
      />,
    );
    expect(oldPersist).toHaveBeenCalledWith(
      snapshot("type-a", "A1"),
      expect.any(Object),
    );

    view.rerender(
      <LayoutCommitter
        authorityKey="authority-b"
        emit
        persist={newPersist}
        reload={newReload}
        title="B1"
        onPromise={onPromise}
      />,
    );
    expect(newPersist).toHaveBeenCalledWith(
      snapshot("type-a", "B1"),
      expect.any(Object),
    );
    expect(oldPersist).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldTransport.resolve(undefined);
      newTransport.resolve(undefined);
      await Promise.all([oldTransport.promise, newTransport.promise]);
    });
    await expect(promises[0]).rejects.toThrow("invalidated");
    await expect(promises[1]).resolves.toBeUndefined();
    expect(oldReload).not.toHaveBeenCalled();
    expect(newReload).toHaveBeenCalledTimes(1);
  });

  it("preserves lane order while a same-authority child layout commit uses rotated callbacks", async () => {
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    const originalPersist = vi.fn().mockImplementation(() => first.promise);
    const refreshedPersist = vi.fn().mockImplementation(() => second.promise);
    const originalReload = vi.fn().mockResolvedValue(undefined);
    const refreshedReload = vi.fn().mockResolvedValue(undefined);
    const promises: Promise<void>[] = [];
    const onPromise = (promise: Promise<void>) => promises.push(promise);
    const view = render(
      <LayoutCommitter
        authorityKey="same-authority"
        emit
        persist={originalPersist}
        reload={originalReload}
        title="E1"
        onPromise={onPromise}
      />,
    );
    view.rerender(
      <LayoutCommitter
        authorityKey="same-authority"
        emit
        persist={refreshedPersist}
        reload={refreshedReload}
        title="E2"
        onPromise={onPromise}
      />,
    );
    expect(originalPersist).toHaveBeenCalledTimes(1);
    expect(refreshedPersist).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve(undefined);
      await first.promise;
    });
    expect(refreshedPersist).toHaveBeenCalledWith(
      snapshot("type-a", "E2"),
      expect.any(Object),
    );
    await act(async () => {
      second.resolve(undefined);
      await second.promise;
    });
    await expect(Promise.all(promises)).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(originalReload).not.toHaveBeenCalled();
    expect(refreshedReload).toHaveBeenCalledTimes(1);
  });

  it("keeps ordering across token-client refresh and uses the latest callbacks for queued work", async () => {
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    const originalPersist = vi.fn().mockImplementationOnce(() => first.promise);
    const refreshedPersist = vi
      .fn()
      .mockImplementationOnce(() => second.promise);
    const originalReload = vi.fn().mockResolvedValue(undefined);
    const refreshedReload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      ({ persist, reload }) =>
        useOntologyRevisionCommitQueue({
          authorityKey: "tenant-1|user-1||||",
          persist,
          reload,
        }),
      { initialProps: { persist: originalPersist, reload: originalReload } },
    );

    void hook.result.current(snapshot("type-a", "E1")).catch(() => undefined);
    void hook.result.current(snapshot("type-a", "E2")).catch(() => undefined);
    hook.rerender({ persist: refreshedPersist, reload: refreshedReload });

    await act(async () => {
      first.resolve(undefined);
      await first.promise;
    });
    expect(refreshedPersist).toHaveBeenCalledWith(
      snapshot("type-a", "E2"),
      expect.any(Object),
    );
    expect(originalReload).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve(undefined);
      await second.promise;
    });
    expect(refreshedReload).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("continues after rejection, runs different types concurrently, and has no stale empty lane", async () => {
    const typeAFirst = deferred<undefined>();
    const typeASecond = deferred<undefined>();
    const typeBFirst = deferred<undefined>();
    const typeAThird = deferred<undefined>();
    const persist = vi
      .fn<(value: OntObjectTypeDef) => Promise<void>>()
      .mockImplementationOnce(() => typeAFirst.promise)
      .mockImplementationOnce(() => typeBFirst.promise)
      .mockImplementationOnce(() => typeASecond.promise)
      .mockImplementationOnce(() => typeAThird.promise);
    const reload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-1|user-1||||",
        persist,
        reload,
      }),
    );

    void hook.result.current(snapshot("type-a", "A1")).catch(() => undefined);
    void hook.result.current(snapshot("type-a", "A2")).catch(() => undefined);
    void hook.result.current(snapshot("type-b", "B1")).catch(() => undefined);
    expect(persist).toHaveBeenCalledTimes(2);

    await act(async () => {
      typeAFirst.reject(new Error("save failed"));
      await typeAFirst.promise.catch(() => undefined);
    });
    expect(persist).toHaveBeenCalledWith(
      snapshot("type-a", "A2"),
      expect.any(Object),
    );

    await act(async () => {
      typeASecond.resolve(undefined);
      await typeASecond.promise;
    });
    expect(reload).not.toHaveBeenCalled();

    await act(async () => {
      typeBFirst.resolve(undefined);
      await typeBFirst.promise;
    });
    expect(reload).toHaveBeenCalledTimes(1);

    void hook.result.current(snapshot("type-a", "A3")).catch(() => undefined);
    expect(persist).toHaveBeenCalledWith(
      snapshot("type-a", "A3"),
      expect.any(Object),
    );
    await act(async () => {
      typeAThird.resolve(undefined);
      await typeAThird.promise;
    });
    expect(reload).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("keeps reload single-flight and runs one final reload after reentrant work", async () => {
    const firstReload = deferred<undefined>();
    const finalReload = deferred<undefined>();
    const persist = vi.fn().mockResolvedValue(undefined);
    let firstReloadGuard: (() => boolean) | undefined;
    let finalReloadGuard: (() => boolean) | undefined;
    const reload = vi
      .fn<(isCurrent?: () => boolean) => Promise<void>>()
      .mockImplementationOnce((isCurrent) => {
        firstReloadGuard = isCurrent;
        return firstReload.promise;
      })
      .mockImplementationOnce((isCurrent) => {
        finalReloadGuard = isCurrent;
        return finalReload.promise;
      });
    const hook = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-1",
        persist,
        reload,
      }),
    );

    await act(async () => {
      await hook.result.current(snapshot("type-a", "A1"));
    });
    expect(reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook.result.current(snapshot("type-a", "A2"));
    });
    expect(persist).toHaveBeenCalledTimes(2);
    const reloadCountWhileFirstWasRunning = reload.mock.calls.length;
    expect(firstReloadGuard?.()).toBe(false);

    await act(async () => {
      firstReload.resolve(undefined);
      await firstReload.promise;
    });
    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(2);
    });
    expect(finalReloadGuard?.()).toBe(true);
    await act(async () => {
      finalReload.resolve(undefined);
      await finalReload.promise;
    });
    expect(reloadCountWhileFirstWasRunning).toBe(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("recovers after synchronously thrown and rejected reloads without unhandled rejections", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const reload = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("sync reload failure");
      })
      .mockRejectedValueOnce(new Error("async reload failure"))
      .mockResolvedValueOnce(undefined);
    const hook = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-1",
        persist: vi.fn().mockResolvedValue(undefined),
        reload,
      }),
    );

    await act(async () => {
      await hook.result.current(snapshot("type-a", "A1"));
    });
    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await hook.result.current(snapshot("type-a", "A2"));
    });
    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await hook.result.current(snapshot("type-a", "A3"));
    });
    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(3);
    });
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("bounds a stalled lane to one running snapshot and one latest tail while settling every caller", async () => {
    const first = deferred<undefined>();
    const persist = vi
      .fn<(value: OntObjectTypeDef) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-1",
        persist,
        reload: vi.fn().mockResolvedValue(undefined),
      }),
    );
    const promises = [hook.result.current(snapshot("type-a", "E0"))];
    for (let index = 1; index <= 100; index += 1) {
      promises.push(
        hook.result.current(snapshot("type-a", `E${String(index)}`)),
      );
    }
    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(undefined);
      await first.promise;
    });
    await expect(Promise.all(promises)).resolves.toHaveLength(101);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith(
      snapshot("type-a", "E100"),
      expect.any(Object),
    );
  });

  it("remains deterministic in StrictMode and invalidates work on unmount", async () => {
    const transport = deferred<undefined>();
    const reload = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      () =>
        useOntologyRevisionCommitQueue({
          authorityKey: "tenant-1",
          persist: vi.fn().mockImplementation(() => transport.promise),
          reload,
        }),
      { wrapper: StrictMode },
    );
    const request = hook.result.current(snapshot("type-a", "E1"));
    void request.catch(() => undefined);
    hook.unmount();
    await act(async () => {
      transport.resolve(undefined);
      await transport.promise;
    });
    await expect(request).rejects.toThrow("invalidated");
    expect(reload).not.toHaveBeenCalled();
  });
  it("derives optional workspace authority without token material or a missing-identity sentinel", () => {
    const session: AuthSession = {
      access_token: "token-a",
      client_session_incarnation: "incarnation-a",
      org_id: "tenant-a",
      user_id: "user-a",
      roles: ["VIEWER"],
      branches: ["branch-a"],
    };
    expect(ontologyWorkspaceAuthorityKey(session, undefined)).toBe(
      ontologyWorkspaceAuthorityKey(
        { ...session, access_token: "token-b" },
        undefined,
      ),
    );
    expect(ontologyWorkspaceAuthorityKey(undefined, undefined)).toBeUndefined();
    expect(
      ontologyWorkspaceAuthorityKey(
        {
          access_token: "missing-incarnation",
          org_id: "tenant-a",
          user_id: "user-a",
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("rejects queue work without explicit authority and invalidates A when authority disappears", async () => {
    const pending = deferred<undefined>();
    const persist = vi.fn().mockImplementation(() => pending.promise);
    const reload = vi.fn().mockResolvedValue(undefined);
    const initialProps: { authorityKey: string | undefined } = {
      authorityKey: "authority-a",
    };
    const hook = renderHook(
      ({ authorityKey }: { authorityKey: string | undefined }) =>
        useOntologyRevisionCommitQueue({ authorityKey, persist, reload }),
      { initialProps },
    );

    const running = hook.result.current(snapshot("type-a", "A"));
    void running.catch(() => undefined);
    expect(persist).toHaveBeenCalledTimes(1);

    hook.rerender({ authorityKey: undefined });
    await expect(
      hook.result.current(snapshot("type-a", "MISSING")),
    ).rejects.toThrow(/invalidated|authority/i);

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    await expect(running).rejects.toThrow(/invalidated|authority/i);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("chains successful key-write receipts instead of replaying the loaded base token", async () => {
    const first = deferred<OntologyRevisionPersistReceipt>();
    const second = deferred<OntologyRevisionPersistReceipt>();
    const seen: ObjectTypeWriteVersion[] = [];
    const persist = vi
      .fn()
      .mockImplementationOnce(
        (
          _value: OntObjectTypeDef,
          context: { expected: ObjectTypeWriteVersion },
        ) => {
          seen.push(context.expected);
          return first.promise;
        },
      )
      .mockImplementationOnce(
        (
          _value: OntObjectTypeDef,
          context: { expected: ObjectTypeWriteVersion },
        ) => {
          seen.push(context.expected);
          return second.promise;
        },
      );
    const hook = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-a",
        persist,
        reload: vi.fn().mockResolvedValue(undefined),
      }),
    );

    const firstWaiter = hook.result.current(snapshot("type-a", "first"));
    const secondWaiter = hook.result.current(snapshot("type-a", "second"));
    expect(seen).toEqual([writeVersion(7)]);

    await act(async () => {
      first.resolve({ writeVersion: writeVersion(8) });
      await first.promise;
    });
    expect(seen).toEqual([writeVersion(7), writeVersion(8)]);
    await act(async () => {
      second.resolve({ writeVersion: writeVersion(9) });
      await second.promise;
    });
    await expect(Promise.all([firstWaiter, secondWaiter])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("aborts a removed host and starts its equal-key successor only after abort acknowledgement", async () => {
    let active = 0;
    let maxActive = 0;
    const oldPersist = vi.fn(
      (_value: OntObjectTypeDef, context: { signal: AbortSignal }) =>
        new Promise<OntologyRevisionPersistReceipt>((_resolve, reject) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          context.signal.addEventListener(
            "abort",
            () => {
              active -= 1;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const oldHost = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "same-authority",
        persist: oldPersist,
        reload: vi.fn().mockResolvedValue(undefined),
        transportDeadlineMs: 100,
        abortGraceMs: 10,
      }),
    );
    const oldWaiter = oldHost.result.current(snapshot("type-a", "old"));
    void oldWaiter.catch(() => undefined);
    oldHost.unmount();

    const newPersist = vi.fn((): Promise<OntologyRevisionPersistReceipt> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return Promise.resolve({ writeVersion: writeVersion(8) });
    });
    const newHost = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "same-authority",
        persist: newPersist,
        reload: vi.fn().mockResolvedValue(undefined),
        transportDeadlineMs: 100,
        abortGraceMs: 10,
      }),
    );
    await expect(
      newHost.result.current(snapshot("type-a", "new")),
    ).resolves.toBeUndefined();
    await expect(oldWaiter).rejects.toThrow(/invalidated/i);
    expect(maxActive).toBe(1);
    expect(newPersist).toHaveBeenCalledTimes(1);
    expect(ontologyRevisionTransportFenceCountForTests()).toBe(0);
  });

  it("scopes an ignored-abort circuit to its exact authority and stable-key lane", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const never = new Promise<OntologyRevisionPersistReceipt>(() => undefined);
    const blockedPersist = vi.fn().mockReturnValue(never);
    const blockedHost = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-a",
        persist: blockedPersist,
        reload: vi.fn().mockResolvedValue(undefined),
        transportDeadlineMs: 20,
        abortGraceMs: 5,
      }),
    );
    const otherKey = deferred<OntologyRevisionPersistReceipt>();
    let otherKeySignal: AbortSignal | undefined;
    const otherKeyPersist = vi.fn(
      (_value: OntObjectTypeDef, context: { signal: AbortSignal }) => {
        otherKeySignal = context.signal;
        return otherKey.promise;
      },
    );
    const otherKeyHost = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-a",
        persist: otherKeyPersist,
        reload: vi.fn().mockResolvedValue(undefined),
        transportDeadlineMs: 1_000,
        abortGraceMs: 5,
      }),
    );
    const otherAuthority = deferred<OntologyRevisionPersistReceipt>();
    let otherAuthoritySignal: AbortSignal | undefined;
    const otherAuthorityPersist = vi.fn(
      (_value: OntObjectTypeDef, context: { signal: AbortSignal }) => {
        otherAuthoritySignal = context.signal;
        return otherAuthority.promise;
      },
    );
    const otherAuthorityHost = renderHook(() =>
      useOntologyRevisionCommitQueue({
        authorityKey: "tenant-b",
        persist: otherAuthorityPersist,
        reload: vi.fn().mockResolvedValue(undefined),
        transportDeadlineMs: 1_000,
        abortGraceMs: 5,
      }),
    );

    const running = blockedHost.result.current(snapshot("type-a", "running"));
    const tail = blockedHost.result.current(snapshot("type-a", "tail"));
    const otherKeyRequest = otherKeyHost.result.current(
      snapshot("type-b", "other-key"),
    );
    const otherAuthorityRequest = otherAuthorityHost.result.current(
      snapshot("type-a", "other-authority"),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    await expect(running).rejects.toThrow(
      /transport_uncertain_reload_required/,
    );
    await expect(tail).rejects.toThrow(/transport_uncertain_reload_required/);
    await expect(
      blockedHost.result.current(snapshot("type-a", "future-same-lane")),
    ).rejects.toThrow(/transport_uncertain_reload_required/);
    expect(blockedPersist).toHaveBeenCalledTimes(1);
    expect(otherKeyPersist).toHaveBeenCalledTimes(1);
    expect(otherAuthorityPersist).toHaveBeenCalledTimes(1);
    expect(otherKeySignal?.aborted).toBe(false);
    expect(otherAuthoritySignal?.aborted).toBe(false);
    expect(ontologyRevisionTransportCircuitOpenForTests()).toBe(true);
    expect(
      ontologyRevisionTransportCircuitOpenForTests("tenant-a", "type-a"),
    ).toBe(true);
    expect(
      ontologyRevisionTransportCircuitOpenForTests("tenant-a", "type-b"),
    ).toBe(false);
    expect(
      ontologyRevisionTransportCircuitOpenForTests("tenant-b", "type-a"),
    ).toBe(false);

    await act(async () => {
      otherKey.resolve({ writeVersion: writeVersion(8) });
      otherAuthority.resolve({ writeVersion: writeVersion(8) });
      await Promise.all([otherKey.promise, otherAuthority.promise]);
    });
    await expect(otherKeyRequest).resolves.toBeUndefined();
    await expect(otherAuthorityRequest).resolves.toBeUndefined();
    expect(ontologyRevisionTransportFenceCountForTests()).toBe(0);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
    blockedHost.unmount();
    otherKeyHost.unmount();
    otherAuthorityHost.unmount();
  });
});
