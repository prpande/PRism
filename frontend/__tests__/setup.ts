import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// #234: raise Testing Library's async-util timeout above the 1000ms default.
// Under full-suite parallel CPU contention, waitFor/findBy on a mocked-fetch
// render (e.g. FilesTab's diff tree) or the real Mermaid dynamic import can
// exceed 1s and flake — green single-threaded, red under load. The wait still
// resolves the instant its condition holds, so passing runs are unaffected; only
// the failure ceiling moves. Kept below vitest.config.ts's testTimeout (20s) so a
// maxed-out wait surfaces its own assertion error rather than a generic test
// timeout.
configure({ asyncUtilTimeout: 8000 });

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
