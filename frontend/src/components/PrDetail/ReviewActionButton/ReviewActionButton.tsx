import { useRef, useState } from 'react';
import type { DraftVerdict } from '../../../api/types';
import { deriveFace, deriveMenu, type ReviewActionInputs } from './reviewActionState';
import { ReviewActionMenu } from './ReviewActionMenu';
import styles from './ReviewActionButton.module.css';

export interface ReviewActionButtonProps extends ReviewActionInputs {
  onPatchVerdict: (v: DraftVerdict | null) => void;
  onOpenSubmit: () => void;
  onResume: () => void;
  onDiscardPending: () => void;
  onDiscardAllDrafts: () => void;
}

function Chevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6.5l4 4 4-4" />
    </svg>
  );
}

export function ReviewActionButton(props: ReviewActionButtonProps) {
  const face = deriveFace(props);
  const [menuOpen, setMenuOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setMenuOpen(false);
    chevronRef.current?.focus();
  };

  const onMainClick = () => {
    if (face.mainAction === 'submit') props.onOpenSubmit();
    else if (face.mainAction === 'resume') props.onResume();
    else setMenuOpen((v) => !v); // closed/merged: main opens the menu
  };

  // Spec §4: disabled / aria-disabled / onClick MUST share one predicate so they
  // never diverge. mainAction === 'none' (closed/merged) is NOT disabled — the main
  // button stays clickable to open the Drafts menu.
  const mainInteractiveDisabled = face.mainDisabled && face.mainAction !== 'none';

  return (
    <div className={styles.root} data-testid="review-action">
      <button
        type="button"
        data-testid="review-action-main"
        className={`${styles.main} ${styles[`fill-${face.fill}`]}`}
        disabled={mainInteractiveDisabled}
        aria-disabled={mainInteractiveDisabled}
        title={face.mainDisabledReason ?? face.pendingTooltip ?? undefined}
        onClick={mainInteractiveDisabled ? undefined : onMainClick}
      >
        {face.needsReconfirm && (
          <span
            className={styles.reconfirm}
            data-testid="review-action-reconfirm"
            aria-hidden="true"
          >
            ⚠
          </span>
        )}
        <span className={styles.label}>
          {face.label}
          {face.pending && (
            <span className={styles.asterisk} aria-hidden="true">
              *
            </span>
          )}
        </span>
      </button>
      <button
        ref={chevronRef}
        type="button"
        data-testid="review-action-chevron"
        className={`${styles.chevron} ${styles[`fill-${face.fill}`]}`}
        aria-label="Review actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={face.frozen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <Chevron />
      </button>
      {menuOpen && !face.frozen && (
        <ReviewActionMenu
          sections={deriveMenu(props)}
          onClose={closeMenu}
          onSelect={(id, verdict) => {
            if (id.startsWith('verdict:')) {
              if (!verdict) return; // mis-route guard — fail loud rather than silently clearing
              props.onPatchVerdict(props.session.draftVerdict === verdict ? null : verdict);
            } else if (id === 'submit') props.onOpenSubmit();
            else if (id === 'resume') props.onResume();
            else if (id === 'discard-pending') props.onDiscardPending();
            else if (id === 'discard-all') props.onDiscardAllDrafts();
            else if (id === 'reconfirm-note') return; // non-interactive label
            setMenuOpen(false);
          }}
        />
      )}
    </div>
  );
}
