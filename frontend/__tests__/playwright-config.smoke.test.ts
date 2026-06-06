// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Parallel-agent port parameterization (#217). The default Playwright config must
// template its server port / health URL / baseURL from PRISM_E2E_PORT (default
// 5180) and must NOT reuse an existing server when a non-default port is requested
// — otherwise two agents on different ports cross-talk by reusing each other's
// backend. This loads the config under different envs via vi.resetModules() +
// dynamic import (the config reads process.env at module load) and restores the
// env per test so it can't leak into siblings in the same worker.
//
// Same spirit as vite-config.smoke.test.ts (a fast config tripwire), different
// mechanism: that one uses Vite's loadConfigFromFile(); this re-imports the module.

type LoadedConfig = {
  webServer: Array<{ command: string; url: string; reuseExistingServer: boolean }>;
  projects: Array<{ use: { baseURL: string } }>;
};

// Resolve the config at runtime via a file URL (NOT a static import specifier):
// playwright.config.ts is intentionally outside tsc's project graph (Playwright
// compiles it itself), so a static `import('../playwright.config')` would drag it
// into tsconfig.app.json and fail `tsc -b` with TS6307. A computed URL keeps it
// out of static analysis while vitest still resolves it at runtime — the same
// load-via-runtime-path approach vite-config.smoke.test.ts uses.
const CONFIG_URL = new URL('../playwright.config.ts', import.meta.url).href;

async function loadConfig(env: { port?: string; ci?: string }): Promise<LoadedConfig> {
  delete process.env.PRISM_E2E_PORT;
  delete process.env.CI;
  if (env.port !== undefined) process.env.PRISM_E2E_PORT = env.port;
  if (env.ci !== undefined) process.env.CI = env.ci;
  vi.resetModules();
  const mod = await import(/* @vite-ignore */ CONFIG_URL);
  return mod.default as unknown as LoadedConfig;
}

describe('playwright.config.ts port parameterization (#217)', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.resetModules();
  });

  it('defaults to 5180 across command/url/baseURL when PRISM_E2E_PORT is unset', async () => {
    const config = await loadConfig({});
    const server = config.webServer[0];
    expect(server.command).toContain('http://localhost:5180');
    expect(server.url).toBe('http://localhost:5180/api/health');
    expect(config.projects[0].use.baseURL).toBe('http://localhost:5180');
  });

  it('reuses an existing server locally on the default port (CI unset)', async () => {
    const config = await loadConfig({});
    expect(config.webServer[0].reuseExistingServer).toBe(true);
  });

  it('templates command/url/baseURL from PRISM_E2E_PORT when a non-default port is set', async () => {
    const config = await loadConfig({ port: '5300' });
    const server = config.webServer[0];
    expect(server.command).toContain('http://localhost:5300');
    expect(server.url).toBe('http://localhost:5300/api/health');
    expect(config.projects[0].use.baseURL).toBe('http://localhost:5300');
  });

  it('never reuses an existing server when a non-default port is requested (avoids cross-agent reuse)', async () => {
    const config = await loadConfig({ port: '5300' });
    expect(config.webServer[0].reuseExistingServer).toBe(false);
  });

  it('never reuses an existing server in CI, regardless of port', async () => {
    const onDefault = await loadConfig({ ci: '1' });
    expect(onDefault.webServer[0].reuseExistingServer).toBe(false);
    const onCustom = await loadConfig({ port: '5300', ci: '1' });
    expect(onCustom.webServer[0].reuseExistingServer).toBe(false);
  });
});
