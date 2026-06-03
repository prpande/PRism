import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const SIDECAR = process.env.PRISM_SIDECAR_BINARY!; // set by the runner to the published binary
const MAIN = path.join(__dirname, "..", "dist", "main.js");

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
  return electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ...launchEnv(dataDir) },
  });
}

test("window opens and loads the app from the sidecar", async () => {
  const app = await launch(tmp("prism-e2e-"), tmp("prism-ud-"));
  const win = await app.firstWindow();
  // The app renders against the loopback sidecar; the health-gated load means the
  // document title / a known root element is present.
  await expect(win.locator("body")).toBeVisible();
  const url = win.url();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  await app.close();
});

test("session handshake: prism-session cookie present and echoed", async () => {
  const app = await launch(tmp("prism-e2e-"), tmp("prism-ud-"));
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");

  // Poll for the cookie rather than reading once. prism-session is stamped on the
  // text/html document response, but the SPA immediately opens a long-lived SSE
  // connection to /api/events, so waitForLoadState("networkidle") never reliably
  // settles (the stream never idles) and a single cookie read races the store.
  // Poll the observable condition with a generous ceiling (project anti-flake rule).
  let hasSession = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const cookies = await win.context().cookies();
    if (cookies.some((c) => c.name === "prism-session")) {
      hasSession = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  expect(hasSession).toBe(true);
  await app.close();
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
  let second: ElectronApplication | null = null;
  try {
    second = await launch(dataDir, userDataDir);
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
  } finally {
    if (second) await second.close().catch(() => {});
  }

  expect(secondWindowOpened).toBe(false);
  await first.close();
});

test("clean quit leaves no orphaned sidecar process", async () => {
  const app = await launch(tmp("prism-e2e-"), tmp("prism-ud-"));
  await app.firstWindow();
  await app.close();

  // Assert the actual sidecar PROCESS is gone — not the lockfile. On Windows,
  // child.kill() maps to TerminateProcess, which does NOT run .NET's graceful
  // ApplicationStopping, so LockfileHandle.Dispose never deletes state.json.lock.
  // The lockfile may legitimately persist after an abrupt kill (the next launch's
  // IsAlive PID+binary takeover handles it); the orphan tell is a live process.
  // Derive the process name from the actual launched binary (not a hardcoded name),
  // so a future rename / Linux artifact doesn't make this pass vacuously.
  const exeName = path.basename(SIDECAR);
  const deadline = Date.now() + 5000;
  while (sidecarProcessRunning(exeName) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(sidecarProcessRunning(exeName)).toBe(false);
});

function sidecarProcessRunning(exeName: string): boolean {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, { encoding: "utf8" });
      return out.includes(exeName);
    }
    const out = execSync(`pgrep -f ${exeName} || true`, { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
