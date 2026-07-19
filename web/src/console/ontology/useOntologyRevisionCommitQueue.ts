import { useCallback, useInsertionEffect, useMemo, useRef } from "react";

import type { ObjectTypeWriteVersion as ApiObjectTypeWriteVersion } from "../../api/ontology";
import type { AuthSession, ViewAsState } from "../../context/auth";
import type { OntObjectTypeDef } from "./types";

export type ObjectTypeWriteVersion = ApiObjectTypeWriteVersion;

export interface OntologyRevisionPersistReceipt {
  writeVersion: ObjectTypeWriteVersion;
}

export interface OntologyRevisionPersistContext {
  expected: ObjectTypeWriteVersion;
  signal: AbortSignal;
}

interface CommitWaiter {
  settled: boolean;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface CommitRequest {
  snapshot: OntObjectTypeDef;
  waiters: CommitWaiter[];
}

interface CommitLane {
  generation: number;
  running: CommitRequest;
  tail?: CommitRequest;
}

type ReloadGuard = () => boolean;

interface CoordinatorCallbacks {
  persist: (
    snapshot: OntObjectTypeDef,
    context: OntologyRevisionPersistContext,
  ) => Promise<OntologyRevisionPersistReceipt | undefined>;
  reload: (isCurrent?: ReloadGuard) => Promise<void>;
  transportDeadlineMs: number;
  abortGraceMs: number;
}

interface ReloadPhase {
  generation: number;
  activity: number;
}

interface CoordinatorState {
  authorityKey: string | undefined;
  renderToken: object;
  renderGenerations: WeakMap<object, number>;
  active: boolean;
  generation: number;
  activity: number;
  callbacks: CoordinatorCallbacks;
  lanes: Map<string, CommitLane>;
  activeTransportControllers: Set<AbortController>;
  reloadNeeded: boolean;
  reloadPhase?: ReloadPhase;
}

export interface OntologyRevisionCommitQueueOptions {
  authorityKey: string | undefined;
  persist: (
    snapshot: OntObjectTypeDef,
    context: OntologyRevisionPersistContext,
  ) => Promise<OntologyRevisionPersistReceipt | undefined>;
  reload: (isCurrent?: ReloadGuard) => Promise<void>;
  transportDeadlineMs?: number;
  abortGraceMs?: number;
}

const INVALIDATED = new Error("Ontology revision commit queue invalidated");
const TRANSPORT_UNCERTAIN = new Error("transport_uncertain_reload_required");
const DEFAULT_TRANSPORT_DEADLINE_MS = 30_000;
const DEFAULT_ABORT_GRACE_MS = 250;

const ontologyRevisionTransportTails = new Map<
  string,
  Promise<ObjectTypeWriteVersion | undefined>
>();
const ontologyRevisionTransportControllers = new Set<AbortController>();
let ontologyRevisionTransportCircuitError: Error | undefined;

function ontologyRevisionTransportKey(
  authorityKey: string,
  stableKey: string,
): string {
  return JSON.stringify([authorityKey, stableKey]);
}

function tripOntologyRevisionTransportCircuit(): Error {
  if (!ontologyRevisionTransportCircuitError) {
    ontologyRevisionTransportCircuitError = TRANSPORT_UNCERTAIN;
    for (const controller of ontologyRevisionTransportControllers) {
      controller.abort(TRANSPORT_UNCERTAIN);
    }
    ontologyRevisionTransportTails.clear();
  }
  return ontologyRevisionTransportCircuitError;
}

function normalizedTransportError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfOntologyRevisionTransportCircuitOpen(): void {
  const circuitError = ontologyRevisionTransportCircuitError;
  if (circuitError) throw circuitError;
}

type TransportSettlement<T> =
  { ok: true; value: T } | { ok: false; error: Error };

async function runAbortableTransport<T>(
  ownerControllers: Set<AbortController>,
  deadlineMs: number,
  graceMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfOntologyRevisionTransportCircuitOpen();
  const controller = new AbortController();
  ownerControllers.add(controller);
  ontologyRevisionTransportControllers.add(controller);

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    abortListener = () => {
      resolve("aborted");
    };
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(operation(controller.signal));
  } catch (error) {
    promise = Promise.reject(normalizedTransportError(error));
  }
  const settled: Promise<TransportSettlement<T>> = promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: normalizedTransportError(error) }),
  );
  void settled.then(() => undefined);

  try {
    const deadline = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(() => {
        controller.abort(
          new DOMException("transport deadline", "TimeoutError"),
        );
        resolve("deadline");
      }, deadlineMs);
    });
    const first = await Promise.race([settled, aborted, deadline]);
    if (typeof first !== "string") {
      throwIfOntologyRevisionTransportCircuitOpen();
      if (first.ok) return first.value;
      throw first.error;
    }

    const graceExpired = new Promise<"grace-expired">((resolve) => {
      graceTimer = setTimeout(() => {
        resolve("grace-expired");
      }, graceMs);
    });
    const afterAbort = await Promise.race([settled, graceExpired]);
    if (afterAbort === "grace-expired") {
      throw tripOntologyRevisionTransportCircuit();
    }
    throwIfOntologyRevisionTransportCircuitOpen();
    if (afterAbort.ok) return afterAbort.value;
    throw afterAbort.error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
    ownerControllers.delete(controller);
    ontologyRevisionTransportControllers.delete(controller);
  }
}

function writeVersionFromSnapshot(
  snapshot: OntObjectTypeDef,
): ObjectTypeWriteVersion {
  const revision = snapshot.keyWriteRevision;
  if (
    typeof snapshot.keyWriteEtag !== "string" ||
    snapshot.keyWriteEtag.length === 0 ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error(
      "Ontology revision commit requires a loaded key write validator",
    );
  }
  return {
    etag: snapshot.keyWriteEtag,
    keyWriteRevision: revision,
  };
}

function runOntologyRevisionTransportFenced(
  key: string,
  base: ObjectTypeWriteVersion,
  ownerControllers: Set<AbortController>,
  deadlineMs: number,
  graceMs: number,
  operation: (
    context: OntologyRevisionPersistContext,
  ) => Promise<OntologyRevisionPersistReceipt | undefined>,
): Promise<ObjectTypeWriteVersion> {
  const previous = ontologyRevisionTransportTails.get(key);
  const invoke = async (prior: ObjectTypeWriteVersion | undefined) => {
    throwIfOntologyRevisionTransportCircuitOpen();
    const expected = prior ?? base;
    const receipt = await runAbortableTransport(
      ownerControllers,
      deadlineMs,
      graceMs,
      (signal) => operation({ expected, signal }),
    );
    return receipt?.writeVersion ?? expected;
  };
  const result = previous ? previous.then(invoke) : invoke(undefined);
  const settledTail = result.then(
    (version) => version,
    () => undefined,
  );
  ontologyRevisionTransportTails.set(key, settledTail);
  void settledTail.then(() => {
    if (ontologyRevisionTransportTails.get(key) === settledTail) {
      ontologyRevisionTransportTails.delete(key);
    }
  });
  return result;
}

export function ontologyRevisionTransportFenceCountForTests(): number {
  return ontologyRevisionTransportTails.size;
}

export function ontologyRevisionTransportCircuitOpenForTests(): boolean {
  return ontologyRevisionTransportCircuitError !== undefined;
}

export function resetOntologyRevisionTransportStateForTests(): void {
  for (const controller of ontologyRevisionTransportControllers) {
    controller.abort(INVALIDATED);
  }
  ontologyRevisionTransportControllers.clear();
  ontologyRevisionTransportTails.clear();
  ontologyRevisionTransportCircuitError = undefined;
}

function rejectWaiters(
  request: CommitRequest | undefined,
  reason: unknown,
): void {
  if (!request) return;
  for (const waiter of request.waiters) {
    if (waiter.settled) continue;
    waiter.settled = true;
    waiter.reject(reason);
  }
}

function resolveWaiters(request: CommitRequest): void {
  for (const waiter of request.waiters) {
    if (waiter.settled) continue;
    waiter.settled = true;
    waiter.resolve();
  }
}

function invalidate(state: CoordinatorState): void {
  state.generation += 1;
  state.activity += 1;
  for (const controller of state.activeTransportControllers) {
    controller.abort(INVALIDATED);
  }
  state.activeTransportControllers.clear();
  for (const lane of state.lanes.values()) {
    rejectWaiters(lane.running, INVALIDATED);
    rejectWaiters(lane.tail, INVALIDATED);
  }
  state.lanes.clear();
  state.reloadNeeded = false;
  state.reloadPhase = undefined;
}

function normalizedSet(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function stableIdentity(
  value: string | undefined,
  name: "org" | "user",
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      `Ontology writable authority requires a stable ${name} identity`,
    );
  }
  return normalized;
}

function stableIncarnation(
  value: string | undefined,
  owner: "effective" | "view-as source",
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      `Ontology writable authority requires an owned ${owner} session incarnation`,
    );
  }
  return normalized;
}

function authorityClaims(session: AuthSession | undefined) {
  return {
    roles: normalizedSet(session?.roles),
    groupRoles: normalizedSet(session?.group_roles),
    featureGrants: normalizedSet(session?.feature_grants),
    branches: normalizedSet(session?.branches),
    isPlatform: session?.isPlatform === true,
  };
}

/**
 * Stable, collision-resistant authority identity for ontology writes. Secret
 * token material is deliberately excluded; every authorization claim that can
 * change write eligibility is normalized into the key instead.
 */
export function ontologyRevisionAuthorityKey(
  session: AuthSession | undefined,
  viewAs: ViewAsState | undefined,
): string {
  const orgId = stableIdentity(viewAs?.actingOrgId ?? session?.org_id, "org");
  const userId = stableIdentity(
    session?.user_id ?? viewAs?.platformSession.user_id,
    "user",
  );
  const effectiveIncarnation = stableIncarnation(
    session?.client_session_incarnation,
    "effective",
  );
  const sourceUserId = viewAs
    ? stableIdentity(viewAs.platformSession.user_id, "user")
    : undefined;
  const sourceIncarnation = viewAs
    ? stableIncarnation(
        viewAs.platformSession.client_session_incarnation,
        "view-as source",
      )
    : undefined;

  return JSON.stringify({
    version: 2,
    effective: {
      orgId,
      userId,
      incarnation: effectiveIncarnation,
      ...authorityClaims(session),
    },
    viewAs: viewAs
      ? {
          orgId: viewAs.actingOrgId,
          role: viewAs.actingRole,
          mode: viewAs.mode ?? null,
          source: viewAs.source ?? null,
          sourceIdentity: {
            orgId: viewAs.platformSession.org_id ?? null,
            userId: sourceUserId,
            incarnation: sourceIncarnation,
            ...authorityClaims(viewAs.platformSession),
          },
        }
      : null,
  });
}

/**
 * Optional read-workspace authority. Writable hosts use the strict helper
 * directly; read-only hosts omit persistence when the owned session identity
 * is unavailable instead of inventing a process-local sentinel.
 */
export function ontologyWorkspaceAuthorityKey(
  session: AuthSession | undefined,
  viewAs: ViewAsState | undefined,
): string | undefined {
  try {
    return ontologyRevisionAuthorityKey(session, viewAs);
  } catch {
    return undefined;
  }
}

function isCurrentLane(
  stateRef: { current: CoordinatorState },
  state: CoordinatorState,
  typeId: string,
  lane: CommitLane,
  generation: number,
): boolean {
  return (
    stateRef.current === state &&
    state.generation === generation &&
    lane.generation === generation &&
    state.lanes.get(typeId) === lane
  );
}

function startReloadIfQuiescent(
  stateRef: { current: CoordinatorState },
  state: CoordinatorState,
  generation: number,
): void {
  if (
    stateRef.current !== state ||
    state.generation !== generation ||
    state.lanes.size > 0 ||
    state.reloadPhase ||
    !state.reloadNeeded
  ) {
    return;
  }

  state.reloadNeeded = false;
  const phase: ReloadPhase = { generation, activity: state.activity };
  state.reloadPhase = phase;
  const reload = state.callbacks.reload;
  const isCurrent: ReloadGuard = () =>
    stateRef.current === state &&
    state.generation === generation &&
    state.reloadPhase === phase &&
    state.activity === phase.activity &&
    state.lanes.size === 0;

  void (async () => {
    try {
      await reload(isCurrent);
    } catch {
      // The host owns current reload error state. A later commit can recover.
    }

    if (
      stateRef.current !== state ||
      state.generation !== generation ||
      state.reloadPhase !== phase
    ) {
      return;
    }
    state.reloadPhase = undefined;
    startReloadIfQuiescent(stateRef, state, generation);
  })();
}

async function runLane(
  stateRef: { current: CoordinatorState },
  state: CoordinatorState,
  typeId: string,
  lane: CommitLane,
  generation: number,
): Promise<void> {
  while (isCurrentLane(stateRef, state, typeId, lane, generation)) {
    const request = lane.running;
    const authorityKey = state.authorityKey;
    let succeeded = true;
    let failure: unknown;
    try {
      if (!authorityKey) throw INVALIDATED;
      const transportKey = ontologyRevisionTransportKey(
        authorityKey,
        request.snapshot.stableKey,
      );
      const base = writeVersionFromSnapshot(request.snapshot);
      await runOntologyRevisionTransportFenced(
        transportKey,
        base,
        state.activeTransportControllers,
        state.callbacks.transportDeadlineMs,
        state.callbacks.abortGraceMs,
        (context) => {
          if (!isCurrentLane(stateRef, state, typeId, lane, generation)) {
            return Promise.reject(INVALIDATED);
          }
          return state.callbacks.persist(request.snapshot, context);
        },
      );
    } catch (error) {
      succeeded = false;
      failure = error;
    }

    if (!isCurrentLane(stateRef, state, typeId, lane, generation)) return;
    if (succeeded) resolveWaiters(request);
    else rejectWaiters(request, failure);

    if (!isCurrentLane(stateRef, state, typeId, lane, generation)) return;
    if (lane.tail) {
      lane.running = lane.tail;
      lane.tail = undefined;
      continue;
    }

    state.lanes.delete(typeId);
    startReloadIfQuiescent(stateRef, state, generation);
    return;
  }
}

function adoptRenderCallbacks(
  state: CoordinatorState,
  renderToken: object,
  authorityKey: string | undefined,
  callbacks: CoordinatorCallbacks,
): boolean {
  if (!state.active) return false;
  const authorityAvailable = authorityKey !== undefined;
  if (state.renderToken === renderToken) {
    return state.authorityKey === authorityKey && authorityAvailable;
  }

  const renderGeneration = state.renderGenerations.get(renderToken);
  if (renderGeneration !== undefined) {
    return (
      renderGeneration === state.generation &&
      state.authorityKey === authorityKey &&
      authorityAvailable
    );
  }

  if (state.authorityKey !== authorityKey) {
    invalidate(state);
    state.authorityKey = authorityKey;
  }
  state.renderToken = renderToken;
  state.renderGenerations.set(renderToken, state.generation);
  state.callbacks = callbacks;
  return authorityAvailable;
}

/**
 * Each mounted host owns its waiters, reloads, and latest-wins lanes. A narrow
 * module-level transport tail serializes only equal authority/stable-key writes
 * across host replacement; different authorities and types remain concurrent.
 */
export function useOntologyRevisionCommitQueue({
  authorityKey: suppliedAuthorityKey,
  persist,
  reload,
  transportDeadlineMs = DEFAULT_TRANSPORT_DEADLINE_MS,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
}: OntologyRevisionCommitQueueOptions): (
  snapshot: OntObjectTypeDef,
) => Promise<void> {
  const authorityKey = suppliedAuthorityKey?.trim() || undefined;
  const renderToken = useMemo<object>(
    () => ({
      authorityKey,
      persist,
      reload,
      transportDeadlineMs,
      abortGraceMs,
    }),
    [authorityKey, persist, reload, transportDeadlineMs, abortGraceMs],
  );
  const stateRef = useRef<CoordinatorState>({
    authorityKey,
    renderToken,
    renderGenerations: new WeakMap([[renderToken, 0]]),
    active: true,
    generation: 0,
    activity: 0,
    callbacks: {
      persist,
      reload,
      transportDeadlineMs,
      abortGraceMs,
    },
    lanes: new Map(),
    activeTransportControllers: new Set(),
    reloadNeeded: false,
  });

  // Commit the render provenance before any descendant layout effect can use a
  // retained closure. This insertion phase only mutates host-local coordinator
  // data; it does not read DOM/attached refs or schedule React state updates.
  useInsertionEffect(() => {
    adoptRenderCallbacks(stateRef.current, renderToken, authorityKey, {
      persist,
      reload,
      transportDeadlineMs,
      abortGraceMs,
    });
  }, [
    authorityKey,
    persist,
    reload,
    renderToken,
    transportDeadlineMs,
    abortGraceMs,
  ]);

  // Insertion cleanup is synchronous on real host removal and is not part of
  // StrictMode's layout/passive replay, so replayed effect consumers keep valid
  // waiters while retained post-unmount closures still fail closed.
  useInsertionEffect(() => {
    const state = stateRef.current;
    state.active = true;
    state.renderGenerations.set(state.renderToken, state.generation);
    return () => {
      state.active = false;
      invalidate(state);
    };
  }, []);

  return useCallback(
    (snapshot: OntObjectTypeDef): Promise<void> => {
      const state = stateRef.current;
      // Validate this closure's committed generation before mutating queue
      // state. Same-authority retained closures use the callbacks already
      // adopted during the insertion phase.
      if (
        !adoptRenderCallbacks(state, renderToken, authorityKey, {
          persist,
          reload,
          transportDeadlineMs,
          abortGraceMs,
        })
      ) {
        return Promise.reject(INVALIDATED);
      }
      const generation = state.generation;
      state.activity += 1;
      state.reloadNeeded = true;

      let waiter!: CommitWaiter;
      const result = new Promise<void>((resolve, reject) => {
        waiter = { settled: false, resolve, reject };
      });
      // Mark the caller-visible promise observed immediately; callers still receive
      // the original rejection, while delayed awaits cannot emit unhandled events.
      void result.catch(() => undefined);
      const lane = state.lanes.get(snapshot.stableKey);
      if (lane) {
        if (lane.tail) {
          lane.tail.snapshot = snapshot;
          lane.tail.waiters.push(waiter);
        } else {
          lane.tail = { snapshot, waiters: [waiter] };
        }
        return result;
      }

      const nextLane: CommitLane = {
        generation,
        running: { snapshot, waiters: [waiter] },
      };
      state.lanes.set(snapshot.stableKey, nextLane);
      void runLane(stateRef, state, snapshot.stableKey, nextLane, generation);
      return result;
    },
    [
      authorityKey,
      persist,
      reload,
      renderToken,
      transportDeadlineMs,
      abortGraceMs,
    ],
  );
}
