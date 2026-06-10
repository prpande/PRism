import { useEffect, useRef } from 'react';
import type React from 'react';
import type { DraftVerdict } from '../../../api/types';
import type { ReviewActionMenuSection } from './reviewActionState';
import styles from './ReviewActionButton.module.css';

interface Props {
  sections: ReviewActionMenuSection[];
  onClose: () => void;
  onSelect: (id: string, verdict?: DraftVerdict) => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export function ReviewActionMenu({ sections, onClose, onSelect, triggerRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const items = sections.flatMap((s) => s.items);

  useEffect(() => {
    // focus first item on open
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      // Tab closes the menu without trapping focus (ARIA APG menu pattern) —
      // do NOT preventDefault, so focus flows naturally past the control.
      else if (e.key === 'Tab') onClose();
    };
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !triggerRef?.current?.contains(t)) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose, triggerRef]);

  // Empty menu (closed/merged with no drafts) → close via effect, NOT during
  // render (calling a parent state-setter in render is a React anti-pattern).
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  const moveFocus = (from: HTMLElement, dir: 1 | -1) => {
    const all = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    const idx = all.indexOf(from as HTMLButtonElement);
    const next = all[(idx + dir + all.length) % all.length];
    next?.focus();
  };

  if (items.length === 0) return null; // close handled by the effect above

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Review actions"
      className={styles.menu}
      data-testid="review-action-menu"
    >
      {sections.map((section, si) => (
        <div key={si} className={styles.section}>
          {section.header && <div className={styles.menuHeader}>{section.header}</div>}
          {section.items.map((it) =>
            it.kind === 'note' ? (
              <div key={it.id} className={styles.note} data-testid="review-action-note">
                {it.label}
              </div>
            ) : (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                className={`${styles.menuItem} ${it.kind === 'danger' ? styles.danger : ''}`}
                onClick={() => onSelect(it.id, it.verdict)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    moveFocus(e.currentTarget, 1);
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    moveFocus(e.currentTarget, -1);
                  }
                }}
              >
                {it.kind === 'verdict' && (
                  <span className={`${styles.swatch} ${styles[`sw-${it.verdict}`]}`} />
                )}
                <span>{it.label}</span>
                {it.checked && (
                  <span className={styles.check} aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
