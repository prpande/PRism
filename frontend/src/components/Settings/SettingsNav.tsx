import { useLocation } from 'react-router-dom';
import { AiMarker } from '../Ai/AiMarker';
import { SettingsLink } from './SettingsLink';
import styles from './SettingsModal.module.css';

interface NavItem {
  section: string;
  label: string;
}
const PRIMARY: NavItem[] = [
  { section: 'appearance', label: 'Appearance' },
  // #496: AI sits after Appearance (display-preference-adjacent). The alternative ordering
  // (feature-config-at-end) is the owner's call during the gated visual pass — spec §Open Questions
  // tracks it. The placement here is intentional pending that sign-off, not an open code TODO.
  { section: 'ai', label: 'AI' },
  { section: 'inbox', label: 'Inbox' },
  { section: 'github-connection', label: 'GitHub Connection' },
];
const SYSTEM: NavItem[] = [{ section: 'system', label: 'Files & logs' }];

// AI sub-pages, rendered beneath the AI parent whenever an /settings/ai* route is active.
const AI_CHILDREN: { path: string; label: string }[] = [
  { path: '/settings/ai', label: 'Configuration' },
  { path: '/settings/ai/usage', label: 'Usage' },
];

function Item({ section, label, active }: NavItem & { active: boolean }) {
  return (
    <SettingsLink
      to={`/settings/${section}`}
      className={active ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
      aria-current={active ? 'page' : undefined}
    >
      {label}
      {section === 'ai' && <AiMarker variant="inline" decorative />}
    </SettingsLink>
  );
}

export function SettingsNav() {
  const { pathname } = useLocation();
  const current = pathname.replace(/^\/settings\/?/, '') || 'appearance';
  // The AI section is active for /settings/ai AND any /settings/ai/* child.
  const aiActive = current === 'ai' || current.startsWith('ai/');
  // The Configuration child is "current" only at exactly /settings/ai (not a descendant).
  const childActive = (childPath: string) =>
    childPath === '/settings/ai' ? current === 'ai' : pathname === childPath;

  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {PRIMARY.map((i) => {
        const active = i.section === 'ai' ? aiActive : current === i.section;
        return (
          <div key={i.section}>
            <Item {...i} active={active} />
            {i.section === 'ai' && aiActive && (
              <div className={styles.navChildren}>
                {AI_CHILDREN.map((c) => (
                  <SettingsLink
                    key={c.path}
                    to={c.path}
                    className={
                      childActive(c.path)
                        ? `${styles.navChild} ${styles.navChildOn}`
                        : styles.navChild
                    }
                    aria-current={childActive(c.path) ? 'page' : undefined}
                  >
                    {c.label}
                  </SettingsLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
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
