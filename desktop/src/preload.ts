import { contextBridge, ipcRenderer } from "electron";

// Preload for the frameless desktop shell. The browser build has NO preload, so
// none of this runs there: window.prism stays undefined and data-shell is never
// set, which means the SPA's shell-gated CSS is inert and the browser experience
// is byte-for-byte identical. Everything here is desktop-only chrome.

const platform = process.platform;

// 1. Mark the document so the SPA's gated CSS (drag region + caption-button
//    inset) activates. documentElement exists at preload time; React never
//    touches data-shell, so the attribute persists across renders. This is the
//    ONLY thing that flips the navbar into a title bar — set exclusively here,
//    never by frontend code, so a plain browser tab can never trigger it.
document.documentElement.dataset.shell = "desktop";
document.documentElement.dataset.shellPlatform = platform;

// 2. Canonical desktop-detection handle for any future renderer code (open-
//    external, native menus, etc.). Cheap and inert today; documented in the
//    shell spec. Exposed across the contextIsolation boundary.
contextBridge.exposeInMainWorld("prism", {
  isDesktop: true,
  platform,
});

// 3. Windows only: keep the native caption-button overlay's color + height in
//    sync with the SPA's theme + density. The renderer owns theme/density state
//    and writes it to <html data-theme>/<html data-density> (applyTheme.ts); we
//    observe those attributes and forward the values to main, which recolors the
//    overlay. One-way DOM observation — no frontend code is aware the title bar
//    exists, preserving the additive-shell invariant. macOS traffic lights need
//    no recoloring (the OS draws them), so this is gated to win32.
if (platform === "win32") {
  const sendState = () => {
    const theme = document.documentElement.dataset.theme ?? "light";
    const density = document.documentElement.dataset.density ?? "comfortable";
    ipcRenderer.send("prism:titlebar-state", { theme, density });
  };
  const observer = new MutationObserver(sendState);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-density"],
  });
  // Baseline before React applies the persisted theme; the observer then fires
  // with the real values once HeaderControls' mount-effect runs applyTheme.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendState, { once: true });
  } else {
    sendState();
  }
}
