import { useLocation, useNavigate } from 'react-router-dom';
import { useOpenTabs, type OpenTab } from '../../contexts/OpenTabsContext';
import { prRefKey, type PrReference } from '../../api/types';
import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';
import styles from './PrTabStrip.module.css';

function tabLabel(t: OpenTab): string {
  return t.title ?? `${t.ref.owner}/${t.ref.repo}#${t.ref.number}`;
}

function isActiveTab(pathname: string, t: OpenTab): boolean {
  const prefix = `/pr/${t.ref.owner}/${t.ref.repo}/${t.ref.number}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function pathFor(ref: PrReference): string {
  return `/pr/${ref.owner}/${ref.repo}/${ref.number}`;
}

/**
 * PrTabStrip — Row 2 browser-style strip listing every open PR tab.
 *
 * The outer tab element is a `<div role="tab" tabIndex={0}>` rather than a
 * `<button>` because the close `×` is a real `<button>` child — nesting
 * interactives inside a `<button>` is invalid HTML. The div keeps full
 * keyboard activation (Enter / Space) via the `onKeyDown` handler.
 *
 * Close interactions:
 *   - Click on the `×` button — closes the tab (stopPropagation prevents the
 *     surrounding tab click from also firing).
 *   - Middle-click anywhere on the tab body — closes the tab (browser-style).
 *   - Both are disabled when a submit is in flight for the tab's prRef; the
 *     `×` becomes `disabled` + tooltip, and middle-click is silently ignored.
 */
export function PrTabStrip() {
  const { openTabs, unreadKeys, closeTab } = useOpenTabs();
  const location = useLocation();
  const navigate = useNavigate();
  const submit = useSubmitInFlight();

  if (openTabs.length === 0) return null;

  // Computes the navigate target BEFORE closeTab() schedules its state update.
  // Lookup is keyed on prRefKey rather than index so a fast-second-click on
  // an adjacent tab (between React commit cycles) doesn't navigate to a stale
  // slot. Inactive tabs close without navigating — the active route is
  // unaffected.
  const handleClose = (closingTab: OpenTab) => {
    const wasActive = isActiveTab(location.pathname, closingTab);
    const closingKey = prRefKey(closingTab.ref);
    const closingIdx = openTabs.findIndex((t) => prRefKey(t.ref) === closingKey);
    const remaining = openTabs.filter((t) => prRefKey(t.ref) !== closingKey);
    closeTab(closingTab.ref);
    if (!wasActive) return;
    // The closed tab was active. Navigate to the neighbour in the PRE-close
    // array so the chosen target is a tab the user will actually see post-close.
    if (closingIdx > 0) {
      navigate(pathFor(openTabs[closingIdx - 1].ref));
    } else if (remaining.length > 0) {
      navigate(pathFor(remaining[0].ref));
    } else {
      navigate('/');
    }
  };

  const handleTabClick = (t: OpenTab) => {
    if (!isActiveTab(location.pathname, t)) {
      navigate(pathFor(t.ref));
    }
  };

  return (
    <div className={styles.tabbar} data-testid="pr-tabstrip" role="tablist" aria-label="Open PRs">
      <div className={styles.inner}>
        {openTabs.map((t) => {
          const key = prRefKey(t.ref);
          const active = isActiveTab(location.pathname, t);
          const unread = unreadKeys.has(key);
          const closeBlocked = submit.inFlight && submit.prRef === key;
          const label = tabLabel(t);
          const className = [
            styles.tab,
            active ? styles.tabActive : '',
            unread ? styles.tabUnread : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={key}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              className={className}
              data-prref={key}
              aria-label={label}
              onClick={() => handleTabClick(t)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleTabClick(t);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1 && !closeBlocked) {
                  e.preventDefault();
                  handleClose(t);
                }
              }}
            >
              <span className={styles.num}>#{t.ref.number}</span>
              <span className={styles.title}>{label}</span>
              {unread && <span className={styles.dot} aria-hidden="true" />}
              <button
                type="button"
                aria-label="Close tab"
                className={styles.close}
                disabled={closeBlocked}
                title={closeBlocked ? "Can't close — submit in progress" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(t);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
