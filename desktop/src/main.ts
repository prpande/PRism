import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import * as path from "node:path";
import { startSidecar, Sidecar } from "./sidecar";
import { titleBarOverlayOptions } from "./titlebar";

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

  // The SPA navbar IS the title bar (titleBarStyle: "hidden" below), so the
  // default Electron application menu (File/Edit/View/Window/Help) is redundant
  // chrome — remove it app-wide so the navbar is the topmost UI.
  Menu.setApplicationMenu(null);

  // Windows: recolor/resize the native caption-button overlay whenever the SPA's
  // theme or density changes (forwarded by preload). Registered once; guarded on
  // platform + a live window. setTitleBarOverlay is a Windows-only API.
  ipcMain.on(
    "prism:titlebar-state",
    (_e, state: { theme: string; density: string }) => {
      if (process.platform !== "win32" || !mainWindow) return;
      mainWindow.setTitleBarOverlay(titleBarOverlayOptions(state.theme, state.density));
    },
  );

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
    // Frameless custom title bar: the SPA navbar becomes the title bar. The
    // preload sets data-shell so the navbar's gated CSS turns into a drag region
    // and reserves space for the OS controls.
    titleBarStyle: "hidden",
    // Windows: draw the min/max/close buttons as an overlay on the right of the
    // navbar. Initial colors assume the light/comfortable default; preload's
    // first titlebar-state message corrects them to the persisted theme within a
    // frame of the SPA mounting.
    ...(process.platform === "win32"
      ? { titleBarOverlay: titleBarOverlayOptions("light", "comfortable") }
      : {}),
    // macOS: float the traffic lights over the navbar, vertically centered in the
    // 56px comfortable header. The OS draws and colors them, so no theme sync.
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 20 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
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
