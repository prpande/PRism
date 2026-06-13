import type { ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Logo } from './Logo';
import { WindowControls } from './WindowControls';
import { GearIcon } from '../PrDetail/FilesTab/diffIcons';
import { HelpIcon } from './HelpIcon';
import { FeedbackIcon } from './FeedbackIcon';
import { useEffectiveLocation, type EffectiveLocation } from '../../hooks/useEffectiveLocation';
import styles from './Header.module.css';

interface HeaderProps {
  // The gate is "authenticated and usable", not merely "has a token": a
  // rejected-token session (authInvalidated) still has a token but is bounced to
  // /setup, so its nav would only bounce. App computes
  // isAuthed = hasToken && !authInvalidated and passes it here (#130).
  isAuthed: boolean;
}

// Active-state (authed nav only — Inbox, Settings, Help, Feedback):
//   Inbox    → pathname === '/' || '/inbox'
//   Settings → pathname === '/settings' || (pathname === '/setup' && ?replace=…)
//   Help     → pathname === '/help'
//   Feedback → pathname === '/feedback'
// Replace-token UX is a Settings affordance, so /setup?replace=1 keeps Settings
// active. There is no standalone Setup tab (#130): first-run hides the nav, and
// re-running setup lives in Settings → Auth ("Replace token").
//
// The global ⌘K search palette is not built yet (#119). Rather than ship a
// permanently-disabled box with a not-allowed cursor, the markup is kept but
// gated behind this flag so nothing dead renders. When the palette lands, ALL
// THREE of these are required — flipping the flag alone would just re-introduce
// the dead control #119 removed: (1) set this to true, (2) remove `disabled`,
// (3) wire the ⌘K handler. It renders only off the Inbox, where the central
// "Paste a PR URL…" box already covers the same need.
const SEARCH_PALETTE_ENABLED = false;

export function Header({ isAuthed }: HeaderProps) {
  const location = useLocation();
  const { pathname } = location;
  const [searchParams] = useSearchParams();
  const isReplaceMode = searchParams.has('replace');

  const inboxActive = pathname === '/' || pathname === '/inbox' || pathname.startsWith('/inbox/');
  const settingsActive =
    pathname === '/settings' ||
    pathname.startsWith('/settings/') ||
    (pathname === '/setup' && isReplaceMode);
  const helpActive = pathname === '/help';
  const feedbackActive = pathname === '/feedback';

  // The page each cluster modal (Settings/Help/Feedback) should open OVER. The
  // shared hook returns the real background: the forwarded backgroundLocation when
  // a modal route is already open, the synthetic Inbox for a cold deep-link to a
  // modal route, else the current page. Using it (rather than a bare `location`)
  // keeps a modal URL from being nested as the next modal's background — the same
  // reason SettingsLink uses it for intra-Settings navigation.
  const effectiveBg = useEffectiveLocation();

  const classFor = (active: boolean) => (active ? styles.tabActive : styles.tab);

  return (
    <header className={styles.header}>
      {/* #215: show the "PRism" wordmark in the empty no-nav header (first-run
          /setup and rejected-token re-auth), but NOT on /welcome, whose hero
          already names the product (avoids a double "PRism" on one screen). When
          authed the nav owns the space, so the mark stands alone. The visible-
          text ⇄ alt coupling lives inside Logo. */}
      <Logo showName={!isAuthed && pathname !== '/welcome'} />
      {/* #130: the nav tab strip renders only when authed. During first-run and
          rejected-token re-auth the tabs would only bounce back to /setup, so the
          <nav> element is omitted entirely (an empty navigation landmark is an a11y
          smell). Logo + WindowControls remain in every state — hiding the desktop
          close button would trap the user. */}
      {isAuthed && (
        <nav className={styles.tabs}>
          <Link
            to="/"
            className={classFor(inboxActive)}
            aria-current={inboxActive ? 'page' : undefined}
          >
            Inbox
          </Link>
        </nav>
      )}
      {/* Unconditional — owns the middle so the Logo stays left-flush in the
          no-nav state. Must NOT be wrapped in the {isAuthed && …} block. */}
      <div className={styles.spacer} data-testid="header-spacer" />
      {SEARCH_PALETTE_ENABLED && !inboxActive && (
        <input
          className={styles.search}
          placeholder="Jump to PR or file… ⌘K"
          title="Search palette — v1.1"
          disabled
          aria-label="Global search (placeholder)"
        />
      )}
      {/* Right-side control cluster, left-to-right: Settings · Help · Feedback ·
          WindowControls (#430). Settings leads the cluster as the primary "system"
          affordance; Feedback is rightmost (closest to the window controls) so the new
          entry point reads as its own thing rather than burying it between the two
          existing icons. All three share .gear / .gearOn so hover, focus, and
          route-active styling are identical — rendered via NavIconLink so that shared
          shape lives in one place. */}
      {isAuthed && (
        <NavIconLink
          to="/settings/appearance"
          label="Settings"
          active={settingsActive}
          bg={effectiveBg}
        >
          <GearIcon />
        </NavIconLink>
      )}
      {isAuthed && (
        <NavIconLink to="/help" label="Help" active={helpActive} bg={effectiveBg}>
          <HelpIcon />
        </NavIconLink>
      )}
      {isAuthed && (
        <NavIconLink to="/feedback" label="Send feedback" active={feedbackActive} bg={effectiveBg}>
          <FeedbackIcon />
        </NavIconLink>
      )}
      {/* Desktop shell only — renders nothing in the browser. The theme/accent/AI
          quick toggles that used to live here were removed (they're in Settings);
          the saved-appearance apply-on-load they also did now lives in the
          headless <AppearanceSync /> mounted by App. */}
      <WindowControls />
    </header>
  );
}

// One icon-link in the right-side .gear cluster (Settings / Help / Feedback). They
// differ only by route, label, icon, and active flag; the route-modal `state`, the
// .gear/.gearOn class swap, and the aria-current coupling are identical, so they live
// here once. `bg` is forwarded as the modal's backgroundLocation so each opens over the
// current page rather than snapping to the Inbox.
function NavIconLink({
  to,
  label,
  active,
  bg,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  bg: EffectiveLocation;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      state={{ backgroundLocation: bg }}
      className={active ? `${styles.gear} ${styles.gearOn}` : styles.gear}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </Link>
  );
}
