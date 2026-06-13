import { contextBridge, ipcRenderer } from "electron";

// Preload for the custom-title-bar desktop shell. The browser build has NO
// preload, so window.prism is undefined there and the SPA's window controls
// render nothing — the browser experience is unaffected.
//
// IMPORTANT — expose the bridge FIRST, with NO DOM access in this file. The
// preload runs at document-start, when `document.documentElement` can still be
// null; touching it here throws and aborts the preload before exposeInMainWorld,
// leaving window.prism undefined (symptom: drag/sticky work via the main-process
// backstop, but the window-control dots never appear). So `data-shell` is owned
// exclusively by main.ts's dom-ready backstop (which runs once <html> exists),
// and this preload only sets up the bridge.

const platform = process.platform;

contextBridge.exposeInMainWorld("prism", {
  isDesktop: true,
  platform,
  openExternal: async (url: string): Promise<boolean> => {
    const ok: boolean = await ipcRenderer.invoke("shell:open-external", url);
    // Observability: a false means the URL was rejected or the OS open threw.
    // On the real data path the URL is always an authoritative GitHub https URL,
    // so this fires only on a misconfiguration or a stray caller. Message is a
    // URL + flag — no token/PII content.
    if (!ok) console.warn("prism.openExternal: rejected", url);
    return ok;
  },
  windowControls: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_e: unknown, maximized: boolean) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", listener);
      return () =>
        ipcRenderer.removeListener("window:maximized-changed", listener);
    },
  },
});
