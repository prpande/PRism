import { contextBridge, ipcRenderer } from "electron";

// Preload for the custom-title-bar desktop shell. The browser build has NO
// preload, so none of this runs there: window.prism stays undefined, the
// SPA's window controls render nothing, and data-shell is never set — the
// browser experience is unaffected. Everything here is desktop-only chrome.

const platform = process.platform;

// 1. Mark the document so the SPA's gated CSS (sticky navbar + drag region)
//    activates. documentElement exists at preload time; React never touches
//    data-shell, so it persists. main.ts also re-asserts this on dom-ready as a
//    sandbox-robustness backstop.
document.documentElement.dataset.shell = "desktop";
document.documentElement.dataset.shellPlatform = platform;

// 2. The desktop bridge: detection flags + window controls the SPA's
//    traffic-light buttons call. ipcRenderer is exposed only through these
//    narrow, named functions (never the raw object) across the contextIsolation
//    boundary.
contextBridge.exposeInMainWorld("prism", {
  isDesktop: true,
  platform,
  windowControls: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_e: unknown, maximized: boolean) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", listener);
      return () => ipcRenderer.removeListener("window:maximized-changed", listener);
    },
  },
});
