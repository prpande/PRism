import { useLocation } from 'react-router-dom';
import { SettingsLink } from './SettingsLink';
import styles from './SettingsModal.module.css';

interface NavItem {
  section: string;
  label: string;
}
const PRIMARY: NavItem[] = [
  { section: 'appearance', label: 'Appearance' },
  // TODO(#496 visual-review): final AI-tab position unresolved (spec §Open Questions —
  // display-preference-adjacent vs feature-config-at-end). Defaulting to after Appearance.
  { section: 'ai', label: 'AI' },
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
      <div className={styles.navGroup} role="group" aria-label="System">
        <div className={styles.navGroupLabel} aria-hidden="true">
          System
        </div>
        {SYSTEM.map((i) => (
          <Item key={i.section} {...i} active={current === i.section} />
        ))}
      </div>
    </nav>
  );
}
