import { useEffect, useRef } from 'react';
import { useCheatsheet } from './CheatsheetProvider';
import { useCheatsheetShortcut } from '../../hooks/useCheatsheetShortcut';
import { SHORTCUTS } from './shortcuts';
import styles from './Cheatsheet.module.css';

export function Cheatsheet() {
  const { isOpen, toggle, close, returnFocusRef } = useCheatsheet();
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useCheatsheetShortcut(toggle, isOpen, close);

  useEffect(() => {
    if (isOpen) {
      // ARIA APG non-modal-dialog pattern: move programmatic focus to the
      // labelling heading on open so screen-reader virtual cursors land on
      // the panel content.
      headingRef.current?.focus();
      return;
    }
    // Close transition: restore focus to the element that was focused at
    // open time, with a liveness guard (the originally-focused element may
    // have unmounted while the overlay was open). Skip when returnFocusRef
    // is null — that's the initial-mount case, NOT a close transition, and
    // we must not steal focus from whatever the app naturally focuses.
    const target = returnFocusRef.current;
    if (target === null) return;
    if (document.contains(target)) {
      target.focus();
    } else {
      // `document.body.focus()` is silently a no-op in some browsers unless
      // body has an explicit tabindex (real-browser quirk; jsdom ignores
      // it). Set tabindex once so the fallback is deterministic.
      if (document.body.tabIndex < 0) document.body.tabIndex = -1;
      document.body.focus();
    }
    returnFocusRef.current = null;
  }, [isOpen, returnFocusRef]);

  if (!isOpen) return null;

  return (
    <div className={styles.backdrop}>
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="cheatsheet-heading"
        className={styles.panel}
      >
        <button
          type="button"
          aria-label="Close cheatsheet"
          className={styles.close}
          onClick={close}
        >
          ×
        </button>
        <h2 id="cheatsheet-heading" ref={headingRef} tabIndex={-1} className={styles.heading}>
          Keyboard shortcuts
        </h2>
        {SHORTCUTS.map((group) => (
          <section key={group.group} className={styles.group}>
            <h3 className={styles.groupHeading}>{group.group}</h3>
            <table className={styles.table}>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={`${group.group}-${row.keys}-${row.context}`}>
                    <td className={styles.keys}>
                      <kbd>{row.keys}</kbd>
                    </td>
                    <td className={styles.context}>{row.context}</td>
                    <td className={styles.action}>{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
