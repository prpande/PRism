import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Logo } from './Logo';
import { HeaderControls } from './HeaderControls';
import { useAuth } from '../../hooks/useAuth';
import styles from './Header.module.css';

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
export function Header() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const { authState } = useAuth();
  const isReplaceMode = searchParams.has('replace');

  const inboxActive = pathname === '/' || pathname === '/inbox' || pathname.startsWith('/inbox/');
  const settingsActive =
    pathname === '/settings' ||
    pathname.startsWith('/settings/') ||
    (pathname === '/setup' && isReplaceMode);
  const setupActive = pathname === '/setup' && !isReplaceMode;

  const needsFirstRun = authState !== null && !authState.hasToken;

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
      <input
        className={styles.search}
        placeholder="Jump to PR or file… ⌘K"
        disabled
        aria-label="Global search (placeholder)"
      />
      <HeaderControls />
    </header>
  );
}
