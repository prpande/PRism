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
