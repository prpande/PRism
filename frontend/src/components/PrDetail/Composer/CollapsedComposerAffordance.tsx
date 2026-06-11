import styles from './CollapsedComposerAffordance.module.css';

export interface CollapsedComposerAffordanceProps {
  label: string;
  ariaLabel: string;
  hasDraft?: boolean;
  readOnly?: boolean;
  onOpen: () => void;
}

// Input-placeholder affordance shared by the diff reply button and Overview's
// reply button. A <button> (Enter/Space activate natively); cursor:text reads
// like a field. Under cross-tab readOnly it uses the native `disabled` attribute
// so it is truly inert — out of the tab order and announced as disabled by
// assistive tech — matching the other readOnly gates in this surface (the inline
// composer's Save/Discard buttons), not a focusable button that no-ops on click.
export function CollapsedComposerAffordance({
  label,
  ariaLabel,
  hasDraft = false,
  readOnly = false,
  onOpen,
}: CollapsedComposerAffordanceProps) {
  return (
    <button
      type="button"
      className={styles.affordance}
      aria-label={ariaLabel}
      disabled={readOnly}
      onClick={onOpen}
    >
      <span className={styles.label}>{label}</span>
      {hasDraft && (
        <span className="composer-badge composer-badge--saved" role="status">
          Saved
        </span>
      )}
    </button>
  );
}
