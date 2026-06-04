import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { prRefKey, type PrReference } from '../../api/types';
import { type PrTabId } from './PrSubTabStrip';
import { PrDetailView } from './PrDetailView';

// Persistent keep-alive host for PR-detail views. Sibling to <Routes> (the /pr
// route renders null), this renders one mounted PrDetailView per open tab and
// hides the inactive ones via the per-view `active` prop. Because every visited
// PR stays mounted, switching tabs (or navigating away and back) preserves each
// view's sub-tab state, scroll position, and in-flight composer drafts — the
// route table no longer owns PR-detail lifecycle.
export function parsePrRoute(
  pathname: string,
): { ref: PrReference; valid: boolean; subTab: PrTabId } | null {
  const m = pathname.match(/^\/pr\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  // Require the number segment to be plain decimal digits. Number() alone is
  // too permissive for a path segment: it would silently accept hex ("0x1f"→31),
  // exponent ("1e3"→1000), and whitespace forms, mapping a malformed URL onto a
  // real PR. The digit guard rejects those; "0"/"00" are excluded via > 0 since
  // PR numbers are 1-based. ("042" still normalizes to 42, matching GitHub.)
  const seg3 = m[3];
  const valid = /^\d+$/.test(seg3) && Number(seg3) > 0;
  const number = Number(seg3);
  const seg = m[4];
  const subTab: PrTabId = seg === 'files' ? 'files' : seg === 'drafts' ? 'drafts' : 'overview';
  return { ref: { owner: m[1], repo: m[2], number }, valid, subTab };
}

export function PrTabHost() {
  const { pathname } = useLocation();
  const { openTabs, addTab } = useOpenTabs();
  const route = parsePrRoute(pathname);
  const activeKey = route && route.valid ? prRefKey(route.ref) : null;
  // Register the active PR as an open tab on navigation. Keyed by the primitive
  // activeKey (not the freshly-constructed `route` object) so it fires once per
  // PR change, not every render. addTab is idempotent on prRefKey. ESLint's
  // react-hooks plugin is not enabled in this config, so no disable directive is
  // needed for the intentionally-narrow dep array.
  useEffect(() => {
    if (route && route.valid) addTab(route.ref, null);
  }, [addTab, activeKey]);
  if (route && !route.valid) {
    return <div role="alert">Invalid PR reference: number must be an integer.</div>;
  }
  return (
    <>
      {openTabs.map((t) => {
        const key = prRefKey(t.ref);
        return (
          <PrDetailView
            key={key}
            prRef={t.ref}
            active={key === activeKey}
            initialSubTab={key === activeKey ? route?.subTab : undefined}
          />
        );
      })}
    </>
  );
}
