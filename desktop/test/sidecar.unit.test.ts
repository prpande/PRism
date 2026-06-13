import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { planSpawn } from "../src/sidecar";

// Absolute on ANY platform: the drive root on Windows (e.g. C:\), the filesystem
// root (/) on POSIX. A hardcoded "C:\..." is RELATIVE on Linux, which made the
// cwd assertion below pass only on Windows (Copilot + claude[bot] CI-portability
// finding).
const ROOT = path.parse(process.cwd()).root;
const base = {
  binaryPath: path.join(ROOT, "apps", "prism", "PRism-win-x64.exe"),
  parentPid: 4242,
};

test("planSpawn anchors cwd to the binary's own directory (ContentRoot/wwwroot resolves)", () => {
  const plan = planSpawn({ ...base, dataDir: null });
  assert.equal(plan.cwd, path.dirname(base.binaryPath));
});

test("planSpawn normalizes a relative binaryPath to absolute (cwd never collapses to '.')", () => {
  const plan = planSpawn({
    binaryPath: path.join("dev-sidecar", "PRism.exe"),
    parentPid: 1,
    dataDir: null,
  });
  assert.ok(path.isAbsolute(plan.binary), "binary should be absolute");
  assert.ok(path.isAbsolute(plan.cwd), "cwd should be absolute");
  assert.notEqual(plan.cwd, ".");
  assert.equal(
    plan.cwd,
    path.dirname(path.resolve(path.join("dev-sidecar", "PRism.exe"))),
  );
});

test("planSpawn passes --no-browser and omits --dataDir when dataDir is null", () => {
  const plan = planSpawn({ ...base, dataDir: null });
  assert.deepEqual(plan.args, ["--no-browser"]);
});

test("planSpawn includes --dataDir when an override is given", () => {
  const plan = planSpawn({ ...base, dataDir: "/tmp/x" });
  assert.deepEqual(plan.args, ["--no-browser", "--dataDir", "/tmp/x"]);
});

test("planSpawn signals sidecar mode and parent pid", () => {
  const plan = planSpawn({ ...base, dataDir: null });
  assert.equal(plan.env.PRISM_SIDECAR, "1");
  assert.equal(plan.env.PRISM_PARENT_PID, "4242");
});

test("planSpawn does not leak arbitrary ambient env vars", () => {
  process.env.PRISM_TEST_LEAK_CANARY = "should-not-pass-through";
  try {
    const plan = planSpawn({ ...base, dataDir: null });
    assert.equal(plan.env.PRISM_TEST_LEAK_CANARY, undefined);
  } finally {
    delete process.env.PRISM_TEST_LEAK_CANARY;
  }
});
