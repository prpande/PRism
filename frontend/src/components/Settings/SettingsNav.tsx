import { useLocation } from 'react-router-dom';
import { SettingsLink } from './SettingsLink';
import styles from './SettingsModal.module.css';

interface NavItem {
  section: string;
  label: string;
}
const PRIMARY: NavItem[] = [
  { section: 'appearance', label: 'Appearance' },
  { section: 'inbox', label: 'Inbox' },
  { section: 'github-connection', label: 'GitHub Connection' },
];
const SYSTEM: NavItem[] = [{ section: 'system', label: 'Files & logs' }];

function Item({ section, label, active }: NavItem & { active: boolean }) {
  return (
    <SettingsLink
      to={`/settings/${section}`}
      className={active ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </SettingsLink>
  );
}

export function SettingsNav() {
  const { pathname } = useLocation();
  const current = pathname.replace(/^\/settings\/?/, '') || 'appearance';
  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {PRIMARY.map((i) => (
        <Item key={i.section} {...i} active={current === i.section} />
      ))}
      <div className={styles.navDivider} role="presentation" />
      <div className={styles.navGroupLabel}>System</div>
      {SYSTEM.map((i) => (
        <Item key={i.section} {...i} active={current === i.section} />
      ))}
    </nav>
  );
}
