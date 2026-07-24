import type { ChildProcess } from "node:child_process";

export interface ObservedChild {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  spawnError: Promise<Error>;
}

export function observeChild(child: ChildProcess): ObservedChild;

export function waitForChildReady(options: {
  observed: ObservedChild;
  checkReady: (options: { signal: AbortSignal }) => boolean | Promise<boolean>;
  getOutput: () => string;
  name?: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void>;

export function stopChild(
  child: ChildProcess,
  options?: { gracePeriodMs?: number },
): Promise<void>;
