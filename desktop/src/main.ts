import { app, BrowserWindow, dialog } from "electron";
import * as path from "node:path";
import { startSidecar, Sidecar } from "./sidecar";

let sidecar: Sidecar | null = null;
let mainWindow: BrowserWindow | null = null;

// Single-instance gate FIRST — before spawning any backend.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", async (e) => {
    if (sidecar) {
      e.preventDefault();
      const s = sidecar;
      sidecar = null;
      await s.stop();
      app.quit();
    }
  });
}

function resolveBinaryPath(): string {
  const exe = process.platform === "win32" ? "PRism-win-x64.exe" : "PRism-osx-arm64";
  // Packaged: extraResources under process.resourcesPath. Dev: env override.
  const fromEnv = process.env.PRISM_SIDECAR_BINARY;
  if (fromEnv) return fromEnv;
  return path.join(process.resourcesPath, "sidecar", exe);
}

function resolveDataDir(): string | null {
  // Only override when a test/dev value is set (PRISM_DATA_DIR, used by the e2e to
  // isolate to a temp dir). Otherwise return null and DON'T pass --dataDir, so the
  // sidecar self-resolves the SAME LocalApplicationData/PRism path the browser-tab
  // build uses — a tester's PAT + drafts carry across both builds instead of the
  // desktop build silently starting from an empty, different directory.
  return process.env.PRISM_DATA_DIR ?? null;
}

async function bootstrap(): Promise<void> {
  try {
    sidecar = await startSidecar({
      binaryPath: resolveBinaryPath(),
      dataDir: resolveDataDir(),
      parentPid: process.pid,
    });
  } catch (err) {
    dialog.showErrorBox("PRism failed to start", String(err));
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(sidecar.baseUrl);
}
