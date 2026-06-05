import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { startSidecar, Sidecar } from "./sidecar";
import { sidecarBinaryName } from "./platform";
import { isOpenableUrl, windowOpenDecision } from "./urls";

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
  //
  // Every handler validates event.sender against the main window's webContents:
  // these channels act on the window, so only the window's own renderer should
  // reach them. It's a single-window app today, but this keeps the surface tight
  // if a second BrowserWindow/webview is ever added.
  const fromMainWindow = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    mainWindow !== null && e.sender === mainWindow.webContents;
  ipcMain.on("window:minimize", (e) => {
    if (fromMainWindow(e)) mainWindow?.minimize();
  });
  ipcMain.on("window:toggle-maximize", (e) => {
    if (!fromMainWindow(e) || !mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on("window:close", (e) => {
    if (fromMainWindow(e)) mainWindow?.close();
  });
  ipcMain.handle("window:is-maximized", (e) =>
    fromMainWindow(e) ? (mainWindow?.isMaximized() ?? false) : false,
  );

  // Open an external URL in the OS browser. shell.openExternal is security-
  // sensitive, so: (1) only the main window's renderer may call (fromMainWindow),
  // (2) only https: URLs pass (isOpenableUrl rejects file:/javascript:/data:/…),
  // (3) the handler never throws to the renderer — returns true on success,
  // false on a rejected URL or a thrown open.
  ipcMain.handle("shell:open-external", async (e, url: string) => {
    if (!fromMainWindow(e)) return false;
    if (typeof url !== "string" || !isOpenableUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
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

function resolveIconPath(): string | undefined {
  // Dev: desktop/assets/icon.ico relative to dist/. Packaged: electron-builder
  // bakes the exe/app icon, and may place assets under the app root. Return the
  // first path that exists so the window (and thus the Windows taskbar) shows
  // PRism's icon; undefined falls back to Electron's default without erroring.
  //
  // .ico only — this sets the WINDOWS window/taskbar icon (the dev pain point).
  // macOS uses .icns for the dock/app icon, which is supplied at PACKAGING time
  // by electron-builder (the later packaging slice), not by BrowserWindow.icon;
  // on macOS this returns undefined and the dev dock icon stays Electron's
  // default. Linux desktop icons are also packaging-time, out of scope here.
  const candidates = [
    path.join(__dirname, "..", "assets", "icon.ico"),
    path.join(process.resourcesPath, "assets", "icon.ico"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function resolveBinaryPath(): string {
  // Dev/e2e override comes FIRST so a non-target host (e.g. Linux CI running the
  // Playwright _electron suite with PRISM_SIDECAR_BINARY pointing at a locally
  // built sidecar) is never rejected by the platform check below.
  const fromEnv = process.env.PRISM_SIDECAR_BINARY;
  if (fromEnv) return fromEnv;
  // Packaged: the per-RID binary lives in extraResources under resourcesPath.
  // sidecarBinaryName throws for any non-publish-target platform/arch instead of
  // falling through to the macOS name and failing opaquely at spawn time.
  const exe = sidecarBinaryName(process.platform, process.arch);
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
    // Targets Windows + macOS (the publish targets); on Linux "hidden" behavior
    // varies by desktop environment and isn't a supported target here.
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External-link safety net. The header's OpenInGitHubButton intercepts its own
  // click, but the diff-truncation + submit-success "Open on GitHub" links are
  // plain target="_blank" anchors with no per-component intercept. Under
  // sandbox:true Electron denies window.open by default and would drop them
  // silently, so route every renderer-initiated open through shell.openExternal
  // (https-only) and never spawn an in-app window. windowOpenDecision always
  // returns action:"deny"; `open` gates the OS-browser hand-off.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const { action, open } = windowOpenDecision(url);
    if (open) void shell.openExternal(url);
    return { action };
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
  //
  // Only data-shell is set — the platform is exposed solely via
  // window.prism.platform (a data-shell-platform attribute had no remaining CSS
  // consumer once the per-platform navbar insets were dropped, so it was dead).
  mainWindow.webContents.on("dom-ready", () => {
    mainWindow?.webContents
      .executeJavaScript(`document.documentElement.dataset.shell = "desktop";`)
      .catch(() => {
        /* page navigated away mid-injection — next dom-ready re-asserts */
      });
  });

  await mainWindow.loadURL(sidecar.baseUrl);
}
