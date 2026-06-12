import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readPortFromStdout, stopChild, DEFAULT_PHASE_TIMEOUT_MS } from "../src/sidecar";

// A minimal ChildProcess stand-in: an EventEmitter (for 'exit'/'error') carrying a
// separate stdout EventEmitter (for 'data'). readPortFromStdout only touches on/off
// on these two emitters, so this is faithful to the surface under test.
function fakeChildWithStdout(): { child: ChildProcess; stdout: EventEmitter } {
  const stdout = new EventEmitter();
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  return { child, stdout };
}

test("readPortFromStdout reassembles a port split across a chunk boundary (no truncation)", async () => {
  const { child, stdout } = fakeChildWithStdout();
  const portPromise = readPortFromStdout(child, 5000);

  // The newline-terminated line "…:5183 (dataDir: /x)\n" arrives in two chunks whose
  // boundary falls inside the port digits. The handshake must wait for the complete
  // line and parse 5183 — not parse the partial first chunk as port 51.
  stdout.emit("data", Buffer.from("PRism listening on http://127.0.0.1:51", "utf8"));
  stdout.emit("data", Buffer.from("83 (dataDir: /x)\n", "utf8"));

  assert.equal(await portPromise, 5183);
});

test("readPortFromStdout still parses a port delivered as one whole line", async () => {
  const { child, stdout } = fakeChildWithStdout();
  const portPromise = readPortFromStdout(child, 5000);
  stdout.emit("data", Buffer.from("PRism listening on http://127.0.0.1:5183 (dataDir: /x)\n", "utf8"));
  assert.equal(await portPromise, 5183);
});

test("DEFAULT_PHASE_TIMEOUT_MS is the named per-phase startup budget (15s)", () => {
  // Model B: the magic 15000 is hoisted to a named constant and applied per phase, not
  // as a single total budget — preserving the ~2× cold-start headroom (#282).
  assert.equal(DEFAULT_PHASE_TIMEOUT_MS, 15000);
});

test("readPortFromStdout honors its own phase budget (rejects on timeout, no port)", async () => {
  const { child } = fakeChildWithStdout();
  // A short budget so the test is fast; the port-read phase rejecting on its own budget is
  // what lets the health-poll phase keep a full, independent budget (model B).
  await assert.rejects(readPortFromStdout(child, 40), /Timed out waiting for backend port/);
});

test("stopChild does not re-kill a child already terminated by a signal (no 5s quit stall)", async () => {
  // A signal-killed child has exitCode === null but signalCode set. The old guard
  // (exitCode !== null only) fell through, sent SIGTERM to a corpse, and blocked the
  // full SIGKILL grace because 'exit' never re-emits. The fix early-returns.
  const killCalls: Array<string | number | undefined> = [];
  const fakeChild = {
    exitCode: null,
    signalCode: "SIGKILL",
    kill: (signal?: string | number) => {
      killCalls.push(signal);
      return true;
    },
    once: () => fakeChild,
  } as unknown as ChildProcess;

  const stopPromise = stopChild(fakeChild);
  // The executor runs synchronously, so any SIGTERM would already be recorded here.
  assert.deepEqual(killCalls, [], "a signal-killed child must not be signalled again");
  await stopPromise; // resolves immediately on the early-return path
});

test("stopChild is a no-op for a child that already exited normally", async () => {
  const killCalls: Array<string | number | undefined> = [];
  const fakeChild = {
    exitCode: 0,
    signalCode: null,
    kill: (signal?: string | number) => {
      killCalls.push(signal);
      return true;
    },
    once: () => fakeChild,
  } as unknown as ChildProcess;

  await stopChild(fakeChild);
  assert.deepEqual(killCalls, []);
});
