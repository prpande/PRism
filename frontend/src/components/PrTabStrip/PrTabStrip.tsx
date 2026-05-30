import { useLocation } from 'react-router-dom';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { prRefKey } from '../../api/types';
import styles from './PrTabStrip.module.css';

/**
 * PrTabStrip — Row 2 browser-style strip listing every open PR tab.
 *
 * Visual skeleton only. The close button is rendered as a non-interactive
 * `<span aria-hidden>` here so the outer `<button role="tab">` doesn't nest
 * a second interactive element. Real click / mousedown / close handlers
 * land in Task 7 (which switches the outer element to `<div role="tab">`
 * to accommodate a real `<button>` close target).
 */
export function PrTabStrip() {
  const { openTabs, unreadKeys } = useOpenTabs();
  const location = useLocation();

  if (openTabs.length === 0) return null;

  return (
    <div className={styles.tabbar} data-testid="pr-tabstrip" role="tablist" aria-label="Open PRs">
      <div className={styles.inner}>
        {openTabs.map((t) => {
          const key = prRefKey(t.ref);
          const active = location.pathname === `/pr/${t.ref.owner}/${t.ref.repo}/${t.ref.number}`;
          const unread = unreadKeys.has(key);
          const label = t.title ?? `${t.ref.owner}/${t.ref.repo}#${t.ref.number}`;
          const className = [
            styles.tab,
            active ? styles.tabActive : '',
            unread ? styles.tabUnread : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              type="button"
              key={key}
              role="tab"
              aria-selected={active}
              className={className}
              data-prref={key}
              aria-label={label}
            >
              <span className={styles.num}>#{t.ref.number}</span>
              <span className={styles.title}>{label}</span>
              {unread && <span className={styles.dot} aria-hidden="true" />}
              <span className={styles.close} aria-hidden="true">
                ×
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
