import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOpenTabs, type OpenTab } from '../../contexts/OpenTabsContext';
import { prRefKey, type PrReference } from '../../api/types';
import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';
import styles from './PrTabStrip.module.css';

const INLINE_TAB_CAP = 6;

function tabLabel(t: OpenTab): string {
  return t.title || `${t.ref.owner}/${t.ref.repo}#${t.ref.number}`;
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
 * DOM shape per tab (post-D92 lift, 2026-05-31):
 *   <div className="tab tabActive? tabUnread?" data-prref>     // outer wrapper
 *     <div role="tab" tabIndex={0} aria-selected ...>
 *       ... #N, title, optional unread dot ...
 *     </div>
 *     <button aria-label="Close tab">×</button>                 // sibling action
 *   </div>
 * The close button is a sibling of role="tab" (not a child) to satisfy WAI-
 * ARIA's no-nested-interactives rule (axe-core nested-interactive). The inner
 * `<div role="tab">` keeps full keyboard activation (Enter / Space) via the
 * `onKeyDown` handler.
 *
 * Note: the overflow menu's `<div role="menuitem">` structure has a related
 * nested-interactive shape (two button children); see plan-deviations note
 * + D85 a11y bundle. Not addressed in this PR.
 *
 * Close interactions:
 *   - Click on the `×` button — closes the tab (stopPropagation prevents the
 *     surrounding tab click from also firing).
 *   - Middle-click anywhere on the tab body — closes the tab (browser-style).
 *   - Both are disabled when a submit is in flight for the tab's prRef; the
 *     `×` becomes `disabled` + tooltip, and middle-click is silently ignored.
 *
 * Overflow:
 *   - First `INLINE_TAB_CAP` tabs render inline.
 *   - Remainder render inside a `+ N more` chevron menu (click-outside +
 *     Escape dismiss, focus returns to the chevron on Escape, menu
 *     auto-closes when the overflow set drains).
 */
export function PrTabStrip() {
  const { openTabs } = useOpenTabs();
  if (openTabs.length === 0) return null;
  return <PrTabStripBody />;
}

function PrTabStripBody() {
  const { openTabs, unreadKeys, closeTab } = useOpenTabs();
  const location = useLocation();
  const navigate = useNavigate();
  const submit = useSubmitInFlight();

  const [menuOpen, setMenuOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);

  const inline = openTabs.slice(0, INLINE_TAB_CAP);
  const overflowed = openTabs.slice(INLINE_TAB_CAP);

  // Click-outside + Escape dismiss + focus return.
  useEffect(() => {
    if (!menuOpen) return;
    const triggerEl = overflowRef.current?.querySelector(`.${styles.more}`) as HTMLElement | null;
    const onMouseDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
        triggerEl?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Auto-close when the overflow set drains.
  useEffect(() => {
    if (overflowed.length === 0 && menuOpen) {
      setMenuOpen(false);
    }
  }, [overflowed.length, menuOpen]);

  // Computes the navigate target BEFORE closeTab() schedules its state update.
  // Lookup is keyed on prRefKey rather than index so a fast-second-click on
  // an adjacent tab (between React commit cycles) doesn't navigate to a stale
  // slot. Inactive tabs close without navigating — the active route is
  // unaffected.
  const handleClose = (closingTab: OpenTab) => {
    const wasActive = isActiveTab(location.pathname, closingTab);
    const closingKey = prRefKey(closingTab.ref);
    const closingIdx = openTabs.findIndex((t) => prRefKey(t.ref) === closingKey);
    if (closingIdx < 0) {
      // Tab already gone (e.g., identity-changed cleared all tabs between
      // render and click). Nothing to close, nothing to navigate to.
      return;
    }
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

  function renderTab(t: OpenTab) {
    const key = prRefKey(t.ref);
    const active = isActiveTab(location.pathname, t);
    const unread = unreadKeys.has(key);
    const closeBlocked = submit.inFlight && submit.prRef === key;
    const wrapperClassName = [
      styles.tab,
      active ? styles.tabActive : '',
      unread ? styles.tabUnread : '',
    ]
      .filter(Boolean)
      .join(' ');
    const label = tabLabel(t);
    return (
      <div key={key} className={wrapperClassName} data-prref={key}>
        <div
          role="tab"
          tabIndex={0}
          aria-selected={active}
          className={styles.tabBody}
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
        </div>
        <button
          type="button"
          aria-label="Close tab"
          className={styles.close}
          disabled={closeBlocked}
          title={closeBlocked ? "Can't close — submit in progress" : undefined}
          onClick={() => handleClose(t)}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className={styles.tabbar} data-testid="pr-tabstrip" role="tablist" aria-label="Open PRs">
      <div className={styles.inner}>
        {inline.map(renderTab)}
        {overflowed.length > 0 && (
          <div className={styles.overflow} ref={overflowRef}>
            <button
              type="button"
              className={styles.more}
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Show ${overflowed.length} more open PR${overflowed.length === 1 ? '' : 's'}`}
            >
              + {overflowed.length} more
            </button>
            {menuOpen && (
              <div role="menu" className={styles.menu}>
                {overflowed.map((t) => {
                  const key = prRefKey(t.ref);
                  const closeBlocked = submit.inFlight && submit.prRef === key;
                  const label = tabLabel(t);
                  return (
                    <div role="menuitem" key={key} className={styles.menuItem}>
                      <span className={styles.menuNum}>#{t.ref.number}</span>
                      <button
                        type="button"
                        className={styles.menuTitle}
                        onClick={() => {
                          setMenuOpen(false);
                          navigate(pathFor(t.ref));
                        }}
                      >
                        {label}
                      </button>
                      <button
                        type="button"
                        aria-label={`Close ${label}`}
                        className={styles.menuClose}
                        disabled={closeBlocked}
                        title={closeBlocked ? "Can't close — submit in progress" : undefined}
                        onClick={() => handleClose(t)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
