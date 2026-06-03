import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
