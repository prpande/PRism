import type { AppDetailsOptions } from "electron";

// The desktop shell's Windows AppUserModelID. Windows groups taskbar buttons by
// this ID, and it is also the `appId` written onto the window's property store
// by windowsTaskbarAppDetails(). Single source of truth so app.setAppUserModelId()
// and the setAppDetails() payload can never drift apart.
export const WINDOWS_APP_USER_MODEL_ID = "com.prpande.prism.desktop";

/**
 * Builds the Windows-only `BrowserWindow.setAppDetails()` payload that pins a
 * taskbar button's icon (and name) to a source Explorer can resolve WITHOUT the
 * app process — or `null` when no payload should be applied.
 *
 * Why this exists: a Windows taskbar button's icon normally comes from the
 * window itself (`WM_GETICON`, set via `BrowserWindow.icon`). But when Explorer
 * rebuilds the button while the owning process can't answer — e.g. it was
 * suspended by Modern Standby across a sleep/wake — Explorer falls back to
 * *app-identity* resolution and then caches that fallback for the life of the
 * button, never re-querying the window. For an unpackaged dev run the identity
 * chain terminates at `electron.exe`, so the button reverts to the Electron atom
 * icon + "Electron" name and stays wrong until relaunch. setAppDetails writes
 * `System.AppUserModel.ID` + `RelaunchIconResource` (+ RelaunchCommand /
 * DisplayName) onto the window's property store, giving Explorer a durable,
 * process-independent source that survives the rebuild.
 *
 * Gated to `win32 && !isPackaged`:
 *   - Non-win32 has no taskbar-button identity model to pin.
 *   - A packaged build is hosted by `PRism.exe`, whose embedded icon already
 *     survives the rebuild, so the fallback is invisible there. Skipping the
 *     call also avoids ever handing Explorer an `appIconPath` inside `app.asar`,
 *     which it (a separate process) cannot read.
 *
 * `appId` MUST be present or Electron ignores every other field; relaunchCommand
 * and relaunchDisplayName are set together (a display name without a command has
 * no effect). When no icon is resolvable the name is still pinned (appIconPath
 * omitted). Pure — no electron/fs at runtime — so it is unit-testable under
 * `node --test`.
 */
export function windowsTaskbarAppDetails(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  execPath: string,
  appDir: string,
  iconPath: string | undefined,
): AppDetailsOptions | null {
  if (platform !== "win32" || isPackaged) return null;
  return {
    appId: WINDOWS_APP_USER_MODEL_ID,
    ...(iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {}),
    relaunchCommand: `"${execPath}" "${appDir}"`,
    relaunchDisplayName: "PRism",
  };
}
