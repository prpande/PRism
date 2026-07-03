import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';

// #234: raise Testing Library's async-util timeout above the 1000ms default.
// Under full-suite parallel CPU contention, waitFor/findBy on a mocked-fetch
// render (e.g. FilesTab's diff tree) or the real Mermaid dynamic import can
// exceed 1s and flake — green single-threaded, red under load. The wait still
// resolves the instant its condition holds, so passing runs are unaffected; only
// the failure ceiling moves. Kept below vitest.config.ts's testTimeout (20s) so a
// maxed-out wait surfaces its own assertion error rather than a generic test
// timeout.
configure({ asyncUtilTimeout: 8000 });

// Default the document.cookie getter to empty for every test (#332). jsdom
// already returns '' by default, so this is a defensive guard that a dozen
// fetch-mock specs each used to re-declare in their own beforeEach. Tests that
// need a specific cookie (api-client.test.tsx's X-PRism-Session echo) override
// the return value with their own spy, which wins over this default.
beforeEach(() => {
  // Guard for the node-environment specs (playwright-config / e2e-origin smoke
  // tests via `@vitest-environment node`) where `document` is absent.
  if (typeof document !== 'undefined') {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
  }
});

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      // Evaluate simple width queries against window.innerWidth at call time so
      // width-gated hooks (useMediaQuery) see the test's viewport. Every other
      // query keeps the historical `matches: false`. Listeners stay no-ops:
      // tests that change innerWidth mid-test must remount (or install their
      // own matchMedia mock) to observe the new width. Only the FIRST width
      // clause of a compound query (e.g. `(min-width: X) and (max-width: Y)`)
      // is evaluated — extend the regex if a compound query ever appears.
      const m = /\((min|max)-width:\s*([\d.]+)px\)/.exec(query);
      const matches = m
        ? m[1] === 'min'
          ? window.innerWidth >= parseFloat(m[2])
          : window.innerWidth <= parseFloat(m[2])
        : false;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}
