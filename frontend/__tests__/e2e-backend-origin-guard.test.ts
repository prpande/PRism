// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard (#239): the e2e suite must NOT hardcode `http://localhost:5180`. The
// backend port is parameterized via PRISM_E2E_PORT (#217), and absolute backend
// URLs / Origin headers must read it through `e2e/helpers/backend-origin.ts`
// (BACKEND_ORIGIN). A stray literal silently defeats parallel-agent isolation:
// the suite boots the backend on (e.g.) 5205 while the literal call still hits
// 5180 → ECONNREFUSED, failing every test in beforeEach. This tripwire keeps the
// invariant from regressing as new specs are added.
//
// The lone legitimate home for the `localhost:<port>` template is the helper
// itself, which derives the origin from the port — it is excluded below.

const E2E_DIR = fileURLToPath(new URL('../e2e', import.meta.url));
const HELPER_REL = path.join('helpers', 'backend-origin.ts');
const FORBIDDEN = 'localhost:5180';

// Resolve the helper at runtime via a file URL (not a static specifier): the e2e
// tree is outside tsc's app project graph, so a static import would drag it in.
// Same load-via-runtime-path approach playwright-config.smoke.test.ts uses.
const HELPER_URL = new URL('../e2e/helpers/backend-origin.ts', import.meta.url).href;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('e2e backend origin guard (#239)', () => {
  it('no e2e file hardcodes localhost:5180 (use BACKEND_ORIGIN instead)', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(E2E_DIR)) {
      if (file.endsWith(HELPER_REL)) continue; // the helper derives the origin from the port
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(FORBIDDEN)) {
        offenders.push(path.relative(E2E_DIR, file));
      }
    }
    expect(
      offenders,
      `These e2e files hardcode ${FORBIDDEN} — replace with BACKEND_ORIGIN from ` +
        `helpers/backend-origin.ts so PRISM_E2E_PORT (#217) is honored:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  describe('backend-origin helper', () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      savedEnv = { ...process.env };
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      vi.resetModules();
    });

    async function loadHelper(
      port?: string,
    ): Promise<{ BACKEND_ORIGIN: string; E2E_PORT: number }> {
      delete process.env.PRISM_E2E_PORT;
      if (port !== undefined) process.env.PRISM_E2E_PORT = port;
      vi.resetModules();
      return (await import(/* @vite-ignore */ HELPER_URL)) as {
        BACKEND_ORIGIN: string;
        E2E_PORT: number;
      };
    }

    it('defaults to :5180 when PRISM_E2E_PORT is unset', async () => {
      const { BACKEND_ORIGIN, E2E_PORT } = await loadHelper();
      expect(E2E_PORT).toBe(5180);
      expect(BACKEND_ORIGIN).toBe('http://localhost:5180');
    });

    it('tracks a valid PRISM_E2E_PORT', async () => {
      const { BACKEND_ORIGIN, E2E_PORT } = await loadHelper('5205');
      expect(E2E_PORT).toBe(5205);
      expect(BACKEND_ORIGIN).toBe('http://localhost:5205');
    });

    it('falls back to :5180 for a malformed PRISM_E2E_PORT', async () => {
      for (const bad of ['-1', '5180.5', 'abc', '0', '70000']) {
        const { BACKEND_ORIGIN } = await loadHelper(bad);
        expect(BACKEND_ORIGIN, `port="${bad}" should fall back`).toBe('http://localhost:5180');
      }
    });
  });
});
