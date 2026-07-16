import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { prRefKey, type PrReference } from '../../api/types';
import { type PrTabId } from './PrSubTabStrip';
import { PrDetailView } from './PrDetailView';
import { ErrorModal } from '../ErrorModal';

// Persistent keep-alive host for PR-detail views. Sibling to <Routes> (the /pr
// route renders null), this renders one mounted PrDetailView per open tab and
// hides the inactive ones via the per-view `active` prop. Because every visited
// PR stays mounted, switching tabs (or navigating away and back) preserves each
// view's sub-tab state, scroll position, and in-flight composer drafts — the
// route table no longer owns PR-detail lifecycle.
// #144 — GitHub name grammar for owner/repo path segments (letters, digits, dot, dash,
// underscore), with the `.`/`..` directory segments excluded so a malformed URL fails fast
// here instead of flowing into /api/pr/{owner}/{repo}/... route matching. Deliberately a
// superset of github.com's exact owner rules (which forbid leading/trailing hyphens etc.):
// the goal is rejecting clearly-invalid segments, not replicating every hosting variant's
// naming policy — GitHub's API is the authority for names that pass this guard.
const NAME_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isValidNameSegment = (seg: string) => NAME_SEGMENT.test(seg) && seg !== '.' && seg !== '..';

export function parsePrRoute(pathname: string): {
  ref: PrReference;
  valid: boolean;
  subTab: PrTabId;
  invalidReason?: 'name' | 'number';
} | null {
  const m = pathname.match(/^\/pr\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  const nameValid = isValidNameSegment(m[1]) && isValidNameSegment(m[2]);
  // Require the number segment to be plain decimal digits. Number() alone is
  // too permissive for a path segment: it would silently accept hex ("0x1f"→31),
  // exponent ("1e3"→1000), and whitespace forms, mapping a malformed URL onto a
  // real PR. The digit guard rejects those; "0"/"00" are excluded via > 0 since
  // PR numbers are 1-based. ("042" still normalizes to 42, matching GitHub.)
  const seg3 = m[3];
  const numberValid = /^\d+$/.test(seg3) && Number(seg3) > 0;
  const valid = nameValid && numberValid;
  // 'name' wins the reason when both are malformed — the URL is garbage either way, and the
  // name message describes the earlier segment the user will look at first.
  const invalidReason = valid ? undefined : !nameValid ? ('name' as const) : ('number' as const);
  const number = Number(seg3);
  const seg = m[4];
  const subTab: PrTabId =
    seg === 'files'
      ? 'files'
      : seg === 'hotspots'
        ? 'hotspots'
        : seg === 'drafts'
          ? 'drafts'
          : 'overview';
  return { ref: { owner: m[1], repo: m[2], number }, valid, subTab, invalidReason };
}

export function PrTabHost() {
  const { pathname } = useEffectiveLocation();
  const navigate = useNavigate();
  const { openTabs, addTab } = useOpenTabs();
  const route = parsePrRoute(pathname);
  const activeKey = route && route.valid ? prRefKey(route.ref) : null;
  // Register the active PR as an open tab on navigation. Keyed by the primitive
  // activeKey (not the freshly-constructed `route` object) so it fires once per
  // PR change, not every render. addTab is idempotent on prRefKey.
  useEffect(() => {
    if (route && route.valid) addTab(route.ref, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the primitive activeKey, not the freshly-constructed `route` object (which changes identity every render) (#331)
  }, [addTab, activeKey]);
  // On a cold direct load of a /pr/... URL (refresh, deep link), openTabs is
  // still empty on first paint — the addTab effect above runs post-render.
  // Union the active route's ref into the mounted set so its view renders
  // immediately instead of flashing blank for a frame. addTab then makes it a
  // permanent openTabs entry (idempotent on prRefKey); because PrDetailView is
  // keyed by prRefKey, it stays mounted across that transition (no remount, no
  // lost state).
  const refs: PrReference[] = openTabs.map((t) => t.ref);
  if (route && route.valid && activeKey && !refs.some((r) => prRefKey(r) === activeKey)) {
    refs.push(route.ref);
  }
  return (
    <>
      {/* Render the invalid-ref alert ALONGSIDE the kept-alive views, not
          instead of them. An early `return <alert/>` would replace the whole
          tree and unmount every open tab — losing each view's sub-tab, visited
          set, and scroll memory — just because the user hit a malformed
          `/pr/o/r/0` URL. With the alert as a sibling, the existing tabs stay
          mounted (all hidden, since an invalid route has no activeKey) and
          their state survives the detour. */}
      {route && !route.valid && (
        <ErrorModal
          open
          title="Invalid PR reference"
          message={
            route.invalidReason === 'name'
              ? 'The repository in the URL is not a valid owner/repo pair.'
              : 'The PR number must be a positive integer.'
          }
          dismissible
          onClose={() => navigate('/')}
          actions={
            <button
              type="button"
              className="btn btn-primary"
              data-modal-role="primary"
              onClick={() => navigate('/')}
            >
              Back to inbox
            </button>
          }
        />
      )}
      {refs.map((ref) => {
        const key = prRefKey(ref);
        return (
          <PrDetailView
            key={key}
            prRef={ref}
            active={key === activeKey}
            initialSubTab={key === activeKey ? route?.subTab : undefined}
          />
        );
      })}
    </>
  );
}
