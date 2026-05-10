import { describe, it, expect } from 'vitest';
import { loadConfigFromFile, type ConfigEnv } from 'vite';
import { resolve } from 'node:path';

// Vite-config regression tripwire. Replaces the [dev] Playwright project
// in CI: rather than spinning up the Vite dev server (slow, parallel-
// startup contention with `dotnet run` on Windows runners → flaky), this
// loads vite.config.ts via Vite's own loader and asserts the load-bearing
// fields are present.
//
// What this catches:
//   - Syntax errors in vite.config.ts.
//   - Plugin import / instantiation failures (e.g., a peer-dep upgrade
//     that broke @vitejs/plugin-react).
//   - The /api proxy disappearing — load-bearing for local dev because
//     the React app's API calls assume same-origin and Vite's proxy is
//     what makes that work against a Kestrel backend on a different port.
//   - The build.outDir drifting away from wwwroot — load-bearing for the
//     [prod] Playwright path and the production single-file binary.
//
// What this does NOT catch:
//   - HMR-specific bugs (would require a running server).
//   - Runtime plugin errors that only surface on actual transform.
//   - The Vite dev server failing to start in CI (the original symptom)
//     — but that's now out of CI scope per the playwright.config.ts split.
//     Local pre-push runs both projects and would catch dev-server breakage.
describe('vite.config.ts smoke', () => {
  it('loads cleanly, instantiates plugins, and preserves load-bearing fields', async () => {
    const env: ConfigEnv = { command: 'serve', mode: 'development' };
    const result = await loadConfigFromFile(env, resolve(process.cwd(), 'vite.config.ts'));

    expect(result).not.toBeNull();
    expect(result!.config).toBeDefined();

    // At least one plugin (the @vitejs/plugin-react entry) instantiated
    // without throwing. A broken plugin import would have made
    // loadConfigFromFile reject before reaching here. We don't recurse
    // into nested plugin arrays — the load-bearing assertion is just
    // "the plugins field exists and contains entries".
    const plugins = result!.config.plugins ?? [];
    expect(plugins.length).toBeGreaterThan(0);

    // /api proxy → backend on 5180. Without this, `apiClient.get('/api/...')`
    // from the React app fails on a 404 in dev mode (Vite serves nothing
    // at /api by default).
    const proxy = result!.config.server?.proxy;
    expect(proxy).toBeDefined();
    expect(proxy!['/api']).toBeDefined();

    // build.outDir drives where `npm run build` deposits the bundle. CI's
    // [prod] Playwright project AND the production single-file binary
    // both serve from wwwroot/, so this is the load-bearing wire to that
    // path.
    expect(result!.config.build?.outDir).toMatch(/wwwroot/);
  });

  it('uses the correct dev server port (5173, matched in playwright.config.ts)', async () => {
    const env: ConfigEnv = { command: 'serve', mode: 'development' };
    const result = await loadConfigFromFile(env, resolve(process.cwd(), 'vite.config.ts'));
    expect(result).not.toBeNull();
    // playwright.config.ts viteDevWebServer hardcodes 5173. Any change
    // here that doesn't update the playwright side would break local
    // [dev] tests on the next push.
    expect(result!.config.server?.port).toBe(5173);
  });
});
