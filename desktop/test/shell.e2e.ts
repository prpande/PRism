import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const SIDECAR = process.env.PRISM_SIDECAR_BINARY!; // set by the runner to the published binary
const MAIN = path.join(__dirname, "..", "dist", "main.js");

// Track every launched app + temp dir so afterEach can tear them down even when a
// test fails mid-body. Without this, an assertion failure in an earlier test leaks a
// live Electron + sidecar process — which would then poison the "no orphan" test's
// global process-name check — and strands temp dirs in the OS tmp folder.
const launchedApps: ElectronApplication[] = [];
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function launchEnv(dataDir: string) {
  return { PRISM_SIDECAR_BINARY: SIDECAR, PRISM_DATA_DIR: dataDir };
}

/**
 * Launch the shell with an ISOLATED Electron user-data dir. The sidecar binds a
 * stable port (PortSelector picks 5180 when free), so a shared user-data dir lets
 * Electron serve index.html from a warm HTTP disk cache on the 2nd+ run — the server
 * never re-runs, so it never re-stamps the `prism-session` Set-Cookie, and the
 * session-handshake assertion goes flaky. A per-launch user-data dir keeps the cache
 * + cookie store cold and makes the suite hermetic. The single-instance test passes
 * the SAME userDataDir to both launches so the requestSingleInstanceLock() collides.
 */
async function launch(dataDir: string, userDataDir: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ...launchEnv(dataDir) },
  });
  launchedApps.push(app);
  return app;
}

test.afterEach(async () => {
  // Close apps first (releases the sidecar child + userData locks), then remove temp
  // dirs. Order matters on Windows: rm before close would hit EBUSY on the lockfile.
  for (const app of launchedApps.splice(0)) {
    await app.close().catch(() => {});
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — temp dirs are reclaimed by the OS anyway
    }
  }
});

test("window opens and loads the app from the sidecar", async () => {
  const app = await launch(tmp("prism-e2e-"), tmp("prism-ud-"));
  const win = await app.firstWindow();
  // The app renders against the loopback sidecar; the health-gated load means the
  // document title / a known root element is present.
  await expect(win.locator("body")).toBeVisible();
  const url = win.url();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
});

test("startup timing line is written to the logs dir (#282)", async () => {
  const app = await launch(tmp("prism-e2e-"), tmp("prism-ud-"));
  const win = await app.firstWindow();
  await expect(win.locator("body")).toBeVisible(); // loadURL resolved → contentLoaded marked → summary emitted

  // The log path is derived from the LAUNCH, not hardcoded: Electron resolves
  // getPath("logs") under userData, which we override per-launch with
  // --user-data-dir. Asserting against the packaged %APPDATA%/PRism/logs default
  // would read an empty directory and pass/fail vacuously.
  const logsDir = await app.evaluate(({ app }) => app.getPath("logs"));
  const logFile = path.join(logsDir, "startup.log");

  // emitStartupSummary() appends synchronously right after loadURL resolves; poll
  // briefly to absorb the gap between firstWindow() and that append landing.
  await expect
    .poll(() => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""), { timeout: 10_000 })
    .toMatch(/^\[startup\] .*\(ms\)$/m);
});

test("session handshake: prism-session cookie is set on the document response", async () => {
  const app = await launch(tmp("prism-e2e-"), tmp("prism-ud-"));
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");

  // prism-session is stamped on the text/html document response, but the SPA
  // immediately opens a long-lived SSE connection to /api/events, so
  // waitForLoadState("networkidle") never reliably settles (the stream never idles)
  // and a single cookie read races the store. expect.poll retries against the test's
  // remaining timeout budget — a hardcoded ceiling could be too tight on a cold start.
  // (Renamed from "...present and echoed": this asserts the cookie is SET; the echo
  // back as X-PRism-Session on later fetches is exercised implicitly by the SPA load.)
  await expect
    .poll(async () => (await win.context().cookies()).some((c) => c.name === "prism-session"), {
      timeout: 30_000,
    })
    .toBe(true);
});

test("single-instance: second launch does not open a second window", async () => {
  const dataDir = tmp("prism-e2e-");
  const userDataDir = tmp("prism-ud-"); // SHARED across both launches → lock collides
  const first = await launch(dataDir, userDataDir);
  await first.firstWindow();

  // The second instance fails requestSingleInstanceLock() and calls app.quit()
  // synchronously — BEFORE app.whenReady() runs bootstrap, so it never creates a
  // window. Because it exits during startup, Playwright's electron.launch() itself
  // REJECTS (the process is gone before the harness can attach). That rejection IS
  // the strongest single-instance signal: the second process died at the gate.
  // If launch() unexpectedly resolves, fall through and assert no window appears.
  let secondWindowOpened = false;
  try {
    const second = await launch(dataDir, userDataDir);
    second.on("window", () => {
      secondWindowOpened = true;
    });
    // Give the (unexpectedly alive) second process a bounded chance to open a window.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !secondWindowOpened) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch {
    // Expected path: the second instance quit at the lock gate during launch.
  }
  // (afterEach closes both `first` and any tracked `second`.)

  expect(secondWindowOpened).toBe(false);
});

test("clean quit leaves no orphaned sidecar process", async () => {
  const app = await launch(tmp("prism-e2e-"), tmp("prism-ud-"));
  await app.firstWindow();

  // Derive the process name from the actual launched binary (not a hardcoded name),
  // so a future rename / Linux artifact doesn't make this pass vacuously.
  const exeName = path.basename(SIDECAR);

  // Positive pre-check: the sidecar MUST be running now (the window loaded, which is
  // health-gated on the sidecar). This proves both that the sidecar launched AND that
  // the detector actually works — without it, the final "gone" assertion could pass
  // vacuously if sidecarProcessRunning() silently returned false for any reason.
  const upDeadline = Date.now() + 5000;
  while (!sidecarProcessRunning(exeName) && Date.now() < upDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(sidecarProcessRunning(exeName)).toBe(true);

  await app.close();

  // Assert the actual sidecar PROCESS is gone — not the lockfile. On Windows,
  // child.kill() maps to TerminateProcess, which does NOT run .NET's graceful
  // ApplicationStopping, so LockfileHandle.Dispose never deletes state.json.lock.
  // The lockfile may legitimately persist after an abrupt kill (the next launch's
  // IsAlive PID+binary takeover handles it); the orphan tell is a live process.
  const downDeadline = Date.now() + 5000;
  while (sidecarProcessRunning(exeName) && Date.now() < downDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(sidecarProcessRunning(exeName)).toBe(false);
});

// Detect whether a process named exeName is running. Uses spawnSync with an argument
// array (no shell), so the binary name is never string-interpolated into a command
// line — no quoting hazard. A real spawn failure returns false, but the no-orphan
// test's positive pre-check (expect(...).toBe(true)) would catch a broken detector
// loudly rather than letting the "gone" assertion pass vacuously.
function sidecarProcessRunning(exeName: string): boolean {
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${exeName}`, "/NH"], {
      encoding: "utf8",
    });
    if (r.error || r.status !== 0) return false;
    return (r.stdout ?? "").includes(exeName);
  }
  // pgrep exit code: 0 = match found, 1 = no match, >1 = error.
  const r = spawnSync("pgrep", ["-f", exeName], { encoding: "utf8" });
  if (r.error) return false;
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}
