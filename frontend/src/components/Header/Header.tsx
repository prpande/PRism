import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Logo } from './Logo';
import { WindowControls } from './WindowControls';
import { GearIcon } from '../PrDetail/FilesTab/diffIcons';
import { HelpIcon } from './HelpIcon';
import styles from './Header.module.css';

interface HeaderProps {
  // The gate is "authenticated and usable", not merely "has a token": a
  // rejected-token session (authInvalidated) still has a token but is bounced to
  // /setup, so its nav would only bounce. App computes
  // isAuthed = hasToken && !authInvalidated and passes it here (#130).
  isAuthed: boolean;
}

// Active-state (authed nav only — Inbox + Settings):
//   Inbox    → pathname === '/' || '/inbox'
//   Settings → pathname === '/settings' || (pathname === '/setup' && ?replace=…)
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

  const classFor = (active: boolean) => (active ? styles.tabActive : styles.tab);

  return (
    <header className={styles.header}>
      <Logo />
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
      {isAuthed && (
        <Link
          to="/help"
          state={{ backgroundLocation: location }}
          className={helpActive ? `${styles.gear} ${styles.gearOn}` : styles.gear}
          aria-label="Help"
          aria-current={helpActive ? 'page' : undefined}
        >
          <HelpIcon />
        </Link>
      )}
      {isAuthed && (
        <Link
          to="/settings/appearance"
          state={{ backgroundLocation: location }}
          className={settingsActive ? `${styles.gear} ${styles.gearOn}` : styles.gear}
          aria-label="Settings"
          aria-current={settingsActive ? 'page' : undefined}
        >
          <GearIcon />
        </Link>
      )}
      {/* Desktop shell only — renders nothing in the browser. The theme/accent/AI
          quick toggles that used to live here were removed (they're in Settings);
          the saved-appearance apply-on-load they also did now lives in the
          headless <AppearanceSync /> mounted by App. */}
      <WindowControls />
    </header>
  );
}
