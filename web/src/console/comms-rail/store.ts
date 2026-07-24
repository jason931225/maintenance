import {
  COMMS_RAIL_SOURCES,
  commsRailGenerationFingerprint,
  loadingCommsRailSnapshot,
  type CommsRailAction,
  type CommsRailGeneration,
  type CommsRailLoadState,
  type CommsRailSnapshot,
  type CommsRailSource,
} from "./model";
import { loadCommsRailSource, performCommsRailAction, type CommsRailApi } from "./adapters";

type Listener = (snapshot: CommsRailSnapshot) => void;
type InvalidationListener = (scope: string, source: CommsRailSource | "all") => void;

/** Shared, non-secret invalidation contract for rail and full module owners. */
export class CommsRailInvalidationBus {
  private readonly listeners = new Set<InvalidationListener>();

  subscribe(listener: InvalidationListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(scope: string, source: CommsRailSource | "all"): void {
    this.listeners.forEach((listener) => { listener(scope, source); });
  }
}
function supports(api: CommsRailApi, action: CommsRailAction): boolean {
  switch (action.kind) {
    case "mark-messenger-read": return api.markMessengerRead !== undefined;
    case "mark-mail-read": return api.markMailRead !== undefined;
    case "mark-notification-read": return api.markNotificationRead !== undefined;
  }
}

function state(api: CommsRailApi, result: Awaited<ReturnType<typeof loadCommsRailSource>>): CommsRailLoadState {
  switch (result.kind) {
    case "ok": {
      // An action with no configured, server-authorized transport is not
      // surfaced to the view. This prevents an inert affordance during an
      // incremental integration or a narrowed caller capability.
      const items = result.items.map((item) => item.action && !supports(api, item.action)
        ? { ...item, action: undefined }
        : item);
      return items.length === 0 ? { kind: "empty" } : { kind: "ready", items, loadedAt: new Date().toISOString() };
    }
    case "denied": return { kind: "denied", status: result.status };
    case "malformed": return { kind: "malformed", code: "malformed_response" };
    case "error": return { kind: "error", code: result.code };
  }
}

/**
 * Authority-fenced state owner. It has no React dependency so shell and drawer
 * integrations can share it without creating a second cache authority.
 */
export class CommsRailStore {
  private snapshot = loadingCommsRailSnapshot();
  private generation: CommsRailGeneration | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly controllers = new Map<CommsRailSource, AbortController>();
  private readonly actionControllers = new Set<AbortController>();
  private unsubscribeBus?: () => void;

  constructor(private readonly api: CommsRailApi, private readonly invalidations = new CommsRailInvalidationBus()) {
    this.unsubscribeBus = invalidations.subscribe((scope, source) => {
      if (!this.generation || commsRailGenerationFingerprint(this.generation) !== scope) return;
      void this.refresh(source === "all" ? COMMS_RAIL_SOURCES : [source]);
    });
  }

  dispose(): void {
    this.controllers.forEach((controller) => { controller.abort(); });
    this.controllers.clear();
    this.actionControllers.forEach((controller) => { controller.abort(); });
    this.actionControllers.clear();
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
    this.listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => { this.listeners.delete(listener); };
  }

  getSnapshot(): CommsRailSnapshot { return this.snapshot; }

  setGeneration(generation: CommsRailGeneration): void {
    if (this.generation && commsRailGenerationFingerprint(this.generation) === commsRailGenerationFingerprint(generation)) return;
    this.controllers.forEach((controller) => { controller.abort(); });
    this.controllers.clear();
    this.actionControllers.forEach((controller) => { controller.abort(); });
    this.actionControllers.clear();
    this.generation = generation;
    this.snapshot = loadingCommsRailSnapshot();
    this.emit();
  }

  async refresh(sources: readonly CommsRailSource[] = COMMS_RAIL_SOURCES): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    await Promise.all(sources.map(async (source) => {
      this.controllers.get(source)?.abort();
      const controller = new AbortController();
      this.controllers.set(source, controller);
      this.update(source, { kind: "loading" });
      try {
        const result = await loadCommsRailSource(this.api, source, generation, controller.signal);
        if (controller.signal.aborted || !this.generation || commsRailGenerationFingerprint(this.generation) !== commsRailGenerationFingerprint(generation) || this.controllers.get(source) !== controller) return;
        this.update(source, state(this.api, result));
      } catch (error) {
        if (controller.signal.aborted || !this.generation || commsRailGenerationFingerprint(this.generation) !== commsRailGenerationFingerprint(generation)) return;
        throw error;
      }
    }));
  }

  async retry(source: CommsRailSource): Promise<void> { await this.refresh([source]); }

  async act(action: CommsRailAction): Promise<"ok" | "denied" | "error" | "aborted"> {
    const generation = this.generation;
    if (!generation) return "denied";
    const controller = new AbortController();
    this.actionControllers.add(controller);
    try {
      const result = await performCommsRailAction(this.api, action, controller.signal);
      if (!this.generation || commsRailGenerationFingerprint(this.generation) !== commsRailGenerationFingerprint(generation)) return "aborted";
      const source: CommsRailSource = action.kind === "mark-messenger-read" ? "messenger" :
        action.kind === "mark-mail-read" ? "mail" : "notifications";
      if (result.kind === "denied") this.update(source, { kind: "denied", status: result.status });
      if (result.kind === "ok") {
        this.invalidations.publish(commsRailGenerationFingerprint(generation), source);
        await this.refresh([source]);
      }
      return result.kind;
    } finally {
      controller.abort();
      this.actionControllers.delete(controller);
    }
  }

  private update(source: CommsRailSource, next: CommsRailLoadState): void {
    this.snapshot = { ...this.snapshot, [source]: next };
    this.emit();
  }

  private emit(): void { this.listeners.forEach((listener) => { listener(this.snapshot); }); }
}
