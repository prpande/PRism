import { useCallback, useRef, useState } from 'react';
import type { DraftVerdict } from '../../../api/types';
import { useDismissableMenu } from '../../../hooks/useDismissableMenu';
import { formatAge } from '../../../utils/relativeTime';
import {
  deriveFace,
  deriveMenu,
  PRIOR_VERDICT_LABEL,
  type ReviewActionInputs,
} from './reviewActionState';
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
  const rootDivRef = useRef<HTMLDivElement>(null);
  // Return focus to the chevron ONLY after activating a menu item (Escape's
  // refocus lives in the shared hook below). On Tab / outside-click no focus is
  // forced back — the user's intended target keeps it (Copilot review). Those
  // paths call closeMenu() bare and let the browser's natural focus flow proceed.
  const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    setMenuOpen(false);
    if (opts?.restoreFocus) chevronRef.current?.focus();
  }, []);

  // Esc + outside-pointerdown dismissal (#705 shared hook). rootDivRef wraps
  // BOTH toggle-capable triggers (main button in the 'change'/'none' faces,
  // chevron always) plus the mounted menu, so a pointerdown on either trigger
  // is never an outside dismissal — each trigger's own onClick owns the toggle.
  useDismissableMenu({
    open: menuOpen && !face.frozen,
    rootRef: rootDivRef,
    returnFocusRef: chevronRef,
    onClose: closeMenu,
  });

  const onMainClick = () => {
    // The main-action paths close an open drafts menu explicitly: the main
    // button sits inside the hook's boundary, so the document listener no
    // longer closes it for us.
    if (face.mainAction === 'submit') {
      setMenuOpen(false);
      props.onOpenSubmit();
    } else if (face.mainAction === 'resume') {
      setMenuOpen(false);
      props.onResume();
    } else setMenuOpen((v) => !v); // 'change' (submitted) and 'none' (closed/merged): main toggles the menu
  };

  // Spec §4: disabled / aria-disabled / onClick MUST share one predicate so they
  // never diverge. mainAction === 'none' (closed/merged) is NOT disabled — the main
  // button stays clickable to open the Drafts menu.
  const mainInteractiveDisabled = face.mainDisabled && face.mainAction !== 'none';

  const caption = face.caption;
  const captionText = caption
    ? caption.mode === 'was'
      ? `was ${PRIOR_VERDICT_LABEL[caption.priorState]} · ${formatAge(caption.submittedAt)}`
      : `You reviewed · ${formatAge(caption.submittedAt)}${caption.stale ? ' · out of date' : ''}`
    : null;
  // SR label only for the idle "reviewed" status (the draft "was" caption is supplementary).
  const mainAriaLabel = caption?.mode === 'reviewed' ? `${face.label} — ${captionText}` : undefined;

  return (
    <div className={styles.wrap} data-testid="review-action-wrap">
      <div ref={rootDivRef} className={styles.root} data-testid="review-action">
        <button
          type="button"
          data-testid="review-action-main"
          className={`${styles.main} ${styles[`fill-${face.fill}`]}`}
          disabled={mainInteractiveDisabled}
          aria-disabled={mainInteractiveDisabled}
          aria-label={mainAriaLabel}
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
              <span
                className={styles.asterisk}
                data-testid="review-action-pending"
                aria-hidden="true"
              >
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
              // Keyboard activation (Enter/Space) unmounts the focused menuitem;
              // restore focus to the chevron so focus never lands on document.body.
              closeMenu({ restoreFocus: true });
            }}
          />
        )}
      </div>
      {captionText && (
        <span
          className={`${styles.caption}${caption?.stale ? ` ${styles.captionStale}` : ''}`}
          data-testid="review-action-caption"
          // Spec §3 a11y: announce the caption when it CHANGES (the reviewed→"was"
          // transition as a draft verdict is picked) so SR users learn the draft
          // differs from their prior verdict. Initial mount isn't announced by
          // aria-live; the static "reviewed" status is carried by the main aria-label.
          aria-live="polite"
        >
          {captionText}
        </span>
      )}
    </div>
  );
}
