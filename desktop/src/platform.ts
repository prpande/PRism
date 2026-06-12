/**
 * Maps a Node `process.platform` / `process.arch` pair to the published sidecar
 * binary filename. Pure (no electron, no fs) so it is unit-testable in isolation.
 *
 * Only the two publish targets are supported — win-x64 (`PRism-win-x64.exe`) and
 * osx-arm64 (`PRism-osx-arm64`), matching the electron-builder targets and the
 * `publish-desktop.yml` CI matrix. Any other platform/arch throws rather than
 * silently returning the macOS name (the pre-hardening behavior, where every
 * non-Windows platform — including Linux and Intel macOS — fell through to the
 * osx-arm64 binary and then failed opaquely at spawn time).
 */
export function sidecarBinaryName(
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (platform === "win32" && arch === "x64") return "PRism-win-x64.exe";
  if (platform === "darwin" && arch === "arm64") return "PRism-osx-arm64";
  throw new Error(
    `Unsupported platform/arch for PRism sidecar: ${platform}/${arch}. ` +
      "Supported targets: win32/x64, darwin/arm64.",
  );
}
