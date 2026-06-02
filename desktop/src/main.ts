import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
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

  // The SPA navbar IS the title bar (titleBarStyle: "hidden" below), so the
  // default Electron application menu (File/Edit/View/Window/Help) is redundant
  // chrome — remove it app-wide so the navbar is the topmost UI.
  Menu.setApplicationMenu(null);

  // Windows groups taskbar buttons by AppUserModelID and reads the icon from it.
  // Without an explicit ID, an unpackaged dev run groups under electron.exe and
  // shows Electron's icon. Set our own ID so the window's icon (below) is what
  // the taskbar displays.
  if (process.platform === "win32") {
    app.setAppUserModelId("com.prpande.prism.desktop");
  }

  // Custom window controls: the SPA renders its own minimize/maximize/close
  // (traffic-light) buttons in the navbar and drives them through these channels.
  // The native OS controls are suppressed (no titleBarOverlay on Windows;
  // setWindowButtonVisibility(false) on macOS) so the look is identical on both.
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on("window:close", () => mainWindow?.close());
  ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);

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

function resolveIconPath(): string | undefined {
  // Dev: desktop/assets/icon.ico relative to dist/. Packaged: electron-builder
  // bakes the exe/app icon, and may place assets under the app root. Return the
  // first path that exists so the window (and thus the Windows taskbar) shows
  // PRism's icon; undefined falls back to Electron's default without erroring.
  const candidates = [
    path.join(__dirname, "..", "assets", "icon.ico"),
    path.join(process.resourcesPath, "assets", "icon.ico"),
  ];
  return candidates.find((p) => fs.existsSync(p));
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

  const iconPath = resolveIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    ...(iconPath ? { icon: iconPath } : {}),
    // Custom title bar: the SPA navbar becomes the title bar, with our own
    // traffic-light window controls. "hidden" drops the native title bar while
    // keeping the OS resize borders + shadow. NO titleBarOverlay — we draw the
    // caption buttons ourselves so they match PRism's design on every platform.
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // macOS: "hidden" still shows the native traffic lights. Hide them so the SPA's
  // own controls are the only ones — identical experience to Windows.
  if (process.platform === "darwin") {
    mainWindow.setWindowButtonVisibility(false);
  }

  // Tell the renderer when the window maximizes/unmaximizes so its maximize
  // button can switch to a restore glyph.
  const emitMaximized = () => {
    mainWindow?.webContents.send("window:maximized-changed", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", emitMaximized);
  mainWindow.on("unmaximize", emitMaximized);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // data-shell drives the navbar's gated CSS (sticky + drag region). It's set
  // here, NOT in the preload: the preload runs at document-start when <html> can
  // still be null, so a DOM write there is unreliable (and would risk aborting
  // the preload before it exposes window.prism). dom-ready runs once <html>
  // exists, in the page's main world; the SPA never touches data-shell, so this
  // is the single, reliable owner. window.prism is owned by the preload.
  mainWindow.webContents.on("dom-ready", () => {
    const platform = JSON.stringify(process.platform);
    mainWindow?.webContents
      .executeJavaScript(
        `document.documentElement.dataset.shell = "desktop";` +
          `document.documentElement.dataset.shellPlatform = ${platform};`,
      )
      .catch(() => {
        /* page navigated away mid-injection — next dom-ready re-asserts */
      });
  });

  await mainWindow.loadURL(sidecar.baseUrl);
}
