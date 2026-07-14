import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WINDOWS_APP_USER_MODEL_ID,
  windowsTaskbarAppDetails,
} from "../src/taskbar";

const ICON = "C:\\app\\assets\\icon.ico";
const EXE = "C:\\app\\node_modules\\electron\\dist\\electron.exe";
const DIR = "C:\\app";

test("windowsTaskbarAppDetails returns the full payload on an unpackaged Windows run", () => {
  assert.deepEqual(windowsTaskbarAppDetails("win32", false, EXE, DIR, ICON), {
    appId: WINDOWS_APP_USER_MODEL_ID,
    appIconPath: ICON,
    appIconIndex: 0,
    relaunchCommand: `"${EXE}" "${DIR}"`,
    relaunchDisplayName: "PRism",
  });
});

test("windowsTaskbarAppDetails always sets appId — Electron ignores every other field without it", () => {
  const details = windowsTaskbarAppDetails("win32", false, EXE, DIR, ICON);
  assert.equal(details?.appId, WINDOWS_APP_USER_MODEL_ID);
});

test("windowsTaskbarAppDetails returns null on a packaged Windows build (the host exe icon already survives the rebuild)", () => {
  assert.equal(windowsTaskbarAppDetails("win32", true, EXE, DIR, ICON), null);
});

test("windowsTaskbarAppDetails returns null off Windows — macOS", () => {
  assert.equal(windowsTaskbarAppDetails("darwin", false, EXE, DIR, ICON), null);
});

test("windowsTaskbarAppDetails returns null off Windows — Linux", () => {
  assert.equal(windowsTaskbarAppDetails("linux", false, EXE, DIR, ICON), null);
});

test("windowsTaskbarAppDetails pins the name even without a resolvable icon, omitting appIconPath", () => {
  const details = windowsTaskbarAppDetails("win32", false, EXE, DIR, undefined);
  assert.deepEqual(details, {
    appId: WINDOWS_APP_USER_MODEL_ID,
    relaunchCommand: `"${EXE}" "${DIR}"`,
    relaunchDisplayName: "PRism",
  });
  assert.equal("appIconPath" in (details as object), false);
});

test("windowsTaskbarAppDetails quotes the exe and dir so spaced paths survive relaunch", () => {
  const details = windowsTaskbarAppDetails(
    "win32",
    false,
    "C:\\Program Files\\PRism\\electron.exe",
    "C:\\Program Files\\PRism",
    ICON,
  );
  assert.equal(
    details?.relaunchCommand,
    `"C:\\Program Files\\PRism\\electron.exe" "C:\\Program Files\\PRism"`,
  );
});
