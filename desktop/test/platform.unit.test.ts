import { test } from "node:test";
import assert from "node:assert/strict";
import { sidecarBinaryName } from "../src/platform";

test("sidecarBinaryName returns the win-x64 exe on Windows x64", () => {
  assert.equal(sidecarBinaryName("win32", "x64"), "PRism-win-x64.exe");
});

test("sidecarBinaryName returns the osx-arm64 binary on Apple Silicon", () => {
  assert.equal(sidecarBinaryName("darwin", "arm64"), "PRism-osx-arm64");
});

test("sidecarBinaryName throws on an unsupported OS (e.g. Linux)", () => {
  assert.throws(() => sidecarBinaryName("linux", "x64"), /Unsupported platform\/arch/);
});

test("sidecarBinaryName throws on an unsupported Windows arch (e.g. arm64)", () => {
  assert.throws(() => sidecarBinaryName("win32", "arm64"), /Unsupported platform\/arch/);
});

test("sidecarBinaryName throws on an unsupported macOS arch (Intel x64 — not a publish target)", () => {
  assert.throws(() => sidecarBinaryName("darwin", "x64"), /Unsupported platform\/arch/);
});

test("sidecarBinaryName names the offending platform/arch in the error", () => {
  assert.throws(() => sidecarBinaryName("freebsd", "ia32"), /freebsd\/ia32/);
});
