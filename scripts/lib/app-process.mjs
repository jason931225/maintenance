export function observeChild(child) {
  let resolveSpawnError;
  let resolveExit;
  const spawnError = new Promise((resolve) => {
    resolveSpawnError = resolve;
  });
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.once("error", resolveSpawnError);
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
  return { child, exited, spawnError };
}

export async function waitForChildReady({
  observed,
  checkReady,
  getOutput,
  name = "mnt-app",
  timeoutMs = 300_000,
  probeTimeoutMs = 10_000,
  pollIntervalMs = 500,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfChildExited(observed.child, getOutput, name);
    const controller = new AbortController();
    const probeTimeout = createTimeout(
      Math.min(probeTimeoutMs, deadline - Date.now()),
      { timedOut: true },
    );
    let outcome;
    try {
      outcome = await Promise.race([
        Promise.resolve()
          .then(() => checkReady({ signal: controller.signal }))
          .then(
            (ready) => ({ ready }),
            () => ({ ready: false }),
          ),
        observed.spawnError.then((error) => ({ error })),
        observed.exited.then((exit) => ({ exit })),
        probeTimeout.promise,
      ]);
    } finally {
      controller.abort();
      probeTimeout.cancel();
    }
    if (outcome.error) {
      throw new Error(`${name} failed to spawn: ${outcome.error.message}`);
    }
    if (outcome.exit) {
      throwChildExited(observed.child, getOutput, name, outcome.exit);
    }
    if (outcome.ready) {
      return;
    }
    if (outcome.timedOut) {
      continue;
    }
    const pollTimeout = createTimeout(pollIntervalMs);
    const delay = await Promise.race([
      pollTimeout.promise,
      observed.spawnError.then((error) => ({ error })),
      observed.exited.then((exit) => ({ exit })),
    ]);
    pollTimeout.cancel();
    if (delay?.error) {
      throw new Error(`${name} failed to spawn: ${delay.error.message}`);
    }
    if (delay?.exit) {
      throwChildExited(observed.child, getOutput, name, delay.exit);
    }
  }
  throwIfChildExited(observed.child, getOutput, name);
  throw new Error(`Timed out waiting for ${name}\n${getOutput()}`);
}

function createTimeout(delayMs, value) {
  let timer;
  const promise = new Promise((resolveTimer) => {
    timer = setTimeout(() => resolveTimer(value), delayMs);
    timer.unref?.();
  });
  return {
    promise,
    cancel: () => clearTimeout(timer),
  };
}

export async function stopChild(child, { gracePeriodMs = 10_000 } = {}) {
  if (hasExited(child) || child.pid === undefined) {
    return;
  }

  const exited = waitForExit(child);
  child.kill("SIGTERM");
  let timeout;
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimer) => {
      timeout = setTimeout(() => resolveTimer(false), gracePeriodMs);
    }),
  ]);
  clearTimeout(timeout);
  if (!stopped && !hasExited(child)) {
    child.kill("SIGKILL");
  }
  await exited;
}

function throwIfChildExited(child, getOutput, name) {
  if (hasExited(child)) {
    throwChildExited(child, getOutput, name);
  }
}

function throwChildExited(child, getOutput, name, exit) {
  const code = exit?.code ?? child.exitCode;
  const signal = exit?.signal ?? child.signalCode ?? "none";
  throw new Error(`${name} exited early: code=${code} signal=${signal}\n${getOutput()}`);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child) {
  if (hasExited(child)) {
    return;
  }
  await new Promise((resolveExit) => {
    child.once("close", resolveExit);
  });
}
