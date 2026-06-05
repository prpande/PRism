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
