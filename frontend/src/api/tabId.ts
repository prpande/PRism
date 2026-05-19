// Per-tab identifier (spec § 3 of cross-tab-stamp-poisoning-design.md). One id is minted
// per browser tab via sessionStorage — same scope as sessionStorage's own lifetime, so a
// fresh tab gets a fresh id, two tabs on the same PR get DIFFERENT ids (the property the
// submit gate relies on to detect cross-tab poisoning attempts), AND a page reload within a
// tab preserves the id.
//
// Allowlist on the server is [a-zA-Z0-9_-]{1,64}; crypto.randomUUID() returns 36-char hex with
// dashes, which fits. Where crypto.randomUUID isn't available (very old browsers, but also
// some test environments), fall back to a small alphabet random — the format still satisfies
// the allowlist.

const STORAGE_KEY = 'prism-tab-id';

// Single source of truth for the cross-tab header name. Submit / mark-viewed / reload / draft
// all reference this so a future rename touches one constant.
export const TAB_ID_HEADER = 'X-PRism-Tab-Id';

function mintTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 16 random chars from the allowlist, sufficient for collision-free per-tab assignment in
  // a single-user PoC. Not cryptographically random; the threat model is "two tabs in one
  // browser collide," not "attacker guesses another tab's id."
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

export function getTabId(): string {
  // sessionStorage may not be available in test contexts (jsdom does provide it; node-default
  // does not). Fall back to a module-level cached id so the function is total — submit gate
  // requires a non-empty header even in those environments.
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_-]{1,64}$/.test(existing)) return existing;
    const fresh = mintTabId();
    sessionStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    if (!fallbackId) fallbackId = mintTabId();
    return fallbackId;
  }
}

let fallbackId: string | null = null;

// Vitest seam — called between tests to mint a fresh id. Clears both the sessionStorage
// key (where the real implementation stores it) AND the in-memory fallback so the next
// getTabId() returns a freshly minted value.
export function __resetTabIdForTest(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore — fallback path below */
  }
  fallbackId = null;
}

// Build-time test hook (Playwright mocked mode). __PRISM_E2E_TEST__ is a custom global
// constant injected by vite.config.ts's `define` from process.env.VITE_E2E_TEST. CI sets
// the env var in .github/workflows/ci.yml so every prod CI build bakes `true` into the
// bundle. Dev builds expose the hook unconditionally via Vite's built-in DEV flag for
// local debugging. The custom token avoids a conflict where Vite's internal
// `import.meta.env` handling overrode user-side `define` of VITE_* keys.
declare global {
  interface Window {
    __prism_test_getTabId?: () => string;
  }
  const __PRISM_E2E_TEST__: boolean;
}
if (import.meta.env.DEV || __PRISM_E2E_TEST__) {
  window.__prism_test_getTabId = getTabId;
}
