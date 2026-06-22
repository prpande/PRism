// Pure URL-safety predicate for the shell:open-external IPC channel. Kept in its
// own module (no Electron imports) so it is unit-testable under `node --test`
// without booting the app. shell.openExternal hands the string to the OS shell,
// so we allow ONLY https: — rejecting file:, javascript:, data:, smb:, etc.
export function isOpenableUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Decision for the main window's setWindowOpenHandler. Any target="_blank" /
// window.open from the renderer (the diff-truncation + submit-success "Open on
// GitHub" links, which are plain anchors with no per-component intercept) is
// ALWAYS denied as an in-app BrowserWindow — under sandbox:true Electron would
// otherwise silently drop the open — and rerouted to the OS browser when the URL
// is https. `action` is always "deny"; `open` gates the shell.openExternal call.
// Kept here (Electron-free) so the always-deny invariant is unit-testable.
export function windowOpenDecision(url: string): {
  action: "deny";
  open: boolean;
} {
  return { action: "deny", open: isOpenableUrl(url) };
}

// Decision for the main window's `will-navigate` guard (#583). A plain in-window
// anchor click is a top-frame NAVIGATION, not a window.open, so it bypasses
// setWindowOpenHandler entirely — without this the BrowserWindow would navigate
// away from the SPA to the external page, leaving a chromeless trap on macOS
// (the native traffic lights are hidden). The SPA is served from the sidecar
// origin (http://127.0.0.1:<port>); React Router uses the history API, which does
// NOT fire will-navigate, so a will-navigate event is always either the initial
// same-origin load or a real escaping navigation. Same-origin top-frame nav is
// allowed; anything else is prevented, and routed to the OS browser ONLY when the
// URL is https (reusing the isOpenableUrl egress invariant — `mailto:`/`http:`
// etc. are prevented but not opened). Kept here (Electron-free) so the decision is
// unit-testable under `node --test`.
export function navigationDecision(
  targetUrl: string,
  appOrigin: string,
): { prevent: boolean; open: boolean } {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { prevent: true, open: false }; // unparseable → block, never open
  }
  if (target.origin === appOrigin) return { prevent: false, open: false };
  return { prevent: true, open: isOpenableUrl(targetUrl) };
}
