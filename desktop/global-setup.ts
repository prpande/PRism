import * as fs from "node:fs";

/**
 * Fail fast with an actionable message when the e2e runner forgot to point
 * PRISM_SIDECAR_BINARY at a published sidecar. Without this, a missing/unset value
 * surfaces deep inside Electron spawn or path.basename(undefined) with a cryptic
 * stack — the test file reads the variable with a non-null assertion.
 */
export default function globalSetup(): void {
  const bin = process.env.PRISM_SIDECAR_BINARY;
  if (!bin) {
    throw new Error(
      "PRISM_SIDECAR_BINARY is not set. Point it at a published self-contained sidecar, e.g.:\n" +
        '  PowerShell: $env:PRISM_SIDECAR_BINARY="$PWD\\sidecar\\PRism-win-x64.exe"\n' +
        '  bash:       PRISM_SIDECAR_BINARY="$(pwd)/sidecar/PRism-win-x64.exe"\n' +
        "See the Phase D plan (Task D1) for the publish + rename steps.",
    );
  }
  if (!fs.existsSync(bin)) {
    throw new Error(`PRISM_SIDECAR_BINARY points to a missing file: ${bin}`);
  }
}
