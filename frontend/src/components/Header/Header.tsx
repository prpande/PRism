import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Logo } from './Logo';
import { WindowControls } from './WindowControls';
import styles from './Header.module.css';

interface HeaderProps {
  // App's useAuth() is the single source — this prop avoids a second
  // useAuth() instance here that would duplicate the focus listener
  // and the /api/auth/state GET on every focus.
  hasToken: boolean;
}

// Spec § 2.1 three-tab active-state:
//   Inbox    → pathname === '/' || '/inbox'
//   Settings → pathname === '/settings' || (pathname === '/setup' && ?replace=…)
//   Setup    → pathname === '/setup' && !?replace=…
// Replace-token UX is a Settings affordance, so /setup?replace=1 keeps Settings
// active and de-activates Setup. Plain Link (not NavLink) is used so the custom
// query-param-aware predicate is the sole driver of aria-current — NavLink's
// built-in path-matching would mark /setup active even when ?replace=1 is set.
// The `·` first-run indicator on Setup communicates first-run-needed without
// altering tab weight (no token yet).
//
// The global ⌘K search palette is not built yet (#119). Rather than ship a
// permanently-disabled box with a not-allowed cursor, the markup is kept but
// gated behind this flag so nothing dead renders. When the palette lands: flip
// to true, remove `disabled`, and wire the handler. It renders only off the
// Inbox, where the central "Paste a PR URL…" box already covers the same need.
const SEARCH_PALETTE_ENABLED = false;

export function Header({ hasToken }: HeaderProps) {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const isReplaceMode = searchParams.has('replace');

  const inboxActive = pathname === '/' || pathname === '/inbox' || pathname.startsWith('/inbox/');
  const settingsActive =
    pathname === '/settings' ||
    pathname.startsWith('/settings/') ||
    (pathname === '/setup' && isReplaceMode);
  const setupActive = pathname === '/setup' && !isReplaceMode;

  const needsFirstRun = !hasToken;

  const classFor = (active: boolean) => (active ? styles.tabActive : styles.tab);

  return (
    <header className={styles.header}>
      <Logo />
      <nav className={styles.tabs}>
        <Link
          to="/"
          className={classFor(inboxActive)}
          aria-current={inboxActive ? 'page' : undefined}
        >
          Inbox
        </Link>
        <Link
          to="/settings"
          className={classFor(settingsActive)}
          aria-current={settingsActive ? 'page' : undefined}
        >
          Settings
        </Link>
        <Link
          to="/setup"
          className={classFor(setupActive)}
          aria-current={setupActive ? 'page' : undefined}
        >
          {needsFirstRun ? '· Setup' : 'Setup'}
        </Link>
      </nav>
      <div className={styles.spacer} />
      {SEARCH_PALETTE_ENABLED && !inboxActive && (
        <input
          className={styles.search}
          placeholder="Jump to PR or file… ⌘K"
          title="Search palette — v1.1"
          disabled
          aria-label="Global search (placeholder)"
        />
      )}
      {/* Desktop shell only — renders nothing in the browser. The theme/accent/AI
          quick toggles that used to live here were removed (they're in Settings);
          the saved-appearance apply-on-load they also did now lives in the
          headless <AppearanceSync /> mounted by App. */}
      <WindowControls />
    </header>
  );
}
