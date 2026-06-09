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
// like a field. Inert (no expand) under cross-tab readOnly.
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
      data-readonly={readOnly || undefined}
      onClick={() => {
        if (readOnly) return;
        onOpen();
      }}
    >
      <span className={styles.label}>{label}</span>
      {hasDraft && (
        <span className="composer-badge composer-badge--saved" role="status">
          saved
        </span>
      )}
    </button>
  );
}
