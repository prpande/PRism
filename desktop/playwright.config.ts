import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.e2e\.ts/,
  // Fail fast with an actionable message if PRISM_SIDECAR_BINARY is unset/missing.
  globalSetup: "./global-setup",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
