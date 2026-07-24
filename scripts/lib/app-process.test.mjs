import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import {
  observeChild,
  stopChild,
  waitForChildReady,
} from "./app-process.mjs";

function startFixture(source) {
  const child = spawn(process.execPath, ["--eval", source], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    child.stdout.once("data", (chunk) => {
      if (chunk.toString() === "ready\n") {
        resolveReady();
      } else {
        rejectReady(new Error(`Unexpected fixture output: ${chunk}`));
      }
    });
    child.once("error", rejectReady);
    child.once("exit", (code, signal) => {
      rejectReady(new Error(`Fixture exited early: code=${code} signal=${signal}`));
    });
  });
  return { observed: observeChild(child), ready };
}

async function childIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

describe("app process lifecycle", () => {
  it("fails readiness promptly when the child exits by signal", async () => {
    const { observed, ready: fixtureReady } = startFixture(
      'console.log("ready"); setInterval(() => {}, 1_000)',
    );
    await fixtureReady;
    const startedAt = Date.now();
    try {
      const ready = waitForChildReady({
        observed,
        checkReady: () => false,
        getOutput: () => "fixture output",
        timeoutMs: 1_000,
        pollIntervalMs: 5,
      });
      setTimeout(() => observed.child.kill("SIGTERM"), 20);
      await assert.rejects(ready, /code=null signal=SIGTERM/);
      assert.ok(Date.now() - startedAt < 250);
    } finally {
      await stopChild(observed.child, { gracePeriodMs: 20 });
    }
    assert.equal(await childIsRunning(observed.child.pid), false);
  });

  it("escalates a TERM-resistant child to SIGKILL and reaps it", async () => {
    const { observed, ready } = startFixture(
      'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1_000)',
    );
    await ready;
    const pid = observed.child.pid;
    await stopChild(observed.child, { gracePeriodMs: 20 });
    assert.equal(observed.child.signalCode, "SIGKILL");
    assert.equal(await childIsRunning(pid), false);
  });

  it("reports a spawn error through readiness and leaves no child", async () => {
    const observed = observeChild(spawn("/definitely/not/a/real/mnt-app"));
    await assert.rejects(
      waitForChildReady({
        observed,
        checkReady: () => false,
        getOutput: () => "",
        timeoutMs: 100,
        pollIntervalMs: 5,
      }),
      /failed to spawn/,
    );
    await stopChild(observed.child, { gracePeriodMs: 20 });
    assert.equal(observed.child.pid, undefined);
  });

  it("bounds a never-settling readiness probe and reaps its child", async () => {
    const { observed, ready } = startFixture(
      'console.log("ready"); setInterval(() => {}, 1_000)',
    );
    await ready;
    const pid = observed.child.pid;
    const startedAt = Date.now();
    try {
      await assert.rejects(
        waitForChildReady({
          observed,
          checkReady: () => new Promise(() => {}),
          getOutput: () => "",
          timeoutMs: 50,
          probeTimeoutMs: 10,
          pollIntervalMs: 5,
        }),
        /Timed out waiting for mnt-app/,
      );
      assert.ok(Date.now() - startedAt < 250);
    } finally {
      await stopChild(observed.child, { gracePeriodMs: 20 });
    }
    assert.equal(await childIsRunning(pid), false);
  });
});
