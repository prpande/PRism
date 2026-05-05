import { NavLink } from 'react-router-dom';
import { Logo } from './Logo';
import { HeaderControls } from './HeaderControls';
import styles from './Header.module.css';

export function Header() {
  return (
    <header className={styles.header}>
      <Logo />
      <nav className={styles.tabs}>
        <NavLink
          to="/inbox-shell"
          className={({ isActive }) => (isActive ? styles.tabActive : styles.tab)}
        >
          Inbox
        </NavLink>
        <NavLink
          to="/setup"
          className={({ isActive }) => (isActive ? styles.tabActive : styles.tab)}
        >
          Setup
        </NavLink>
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
