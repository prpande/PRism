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

function Item({
  section,
  label,
  active,
  ariaCurrent,
}: NavItem & { active: boolean; ariaCurrent?: 'page' | 'true' }) {
  return (
    <SettingsLink
      to={`/settings/${section}`}
      className={active ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
      aria-current={ariaCurrent}
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
  // A child is "current" only at its exact path — Configuration (/settings/ai) is NOT current at the
  // /settings/ai/usage descendant. One consistent comparison (no /settings/ai special-case needed).
  const childActive = (childPath: string) => pathname === childPath;

  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {PRIMARY.map((i) => {
        const active = i.section === 'ai' ? aiActive : current === i.section;
        // aria-current="page" only when this link's own target IS the current route. The AI parent
        // stays styled-active for any /settings/ai* route, but when a child is current it points at an
        // ancestor → aria-current="true", not "page".
        const ariaCurrent: 'page' | 'true' | undefined = !active
          ? undefined
          : i.section === 'ai' && current !== 'ai'
            ? 'true'
            : 'page';
        return (
          <div key={i.section}>
            <Item {...i} active={active} ariaCurrent={ariaCurrent} />
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
          <Item
            key={i.section}
            {...i}
            active={current === i.section}
            ariaCurrent={current === i.section ? 'page' : undefined}
          />
        ))}
      </div>
    </nav>
  );
}
