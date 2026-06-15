import styles from './ChangeNavControls.module.css';

export interface ChangeNavControlsProps {
  total: number;
  currentIdx: number; // -1..total-1
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

// git-compare glyph in the diffIcons house style (16x16, currentColor)
function ChangeNavIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="4" cy="4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4 5.7v3.1a2 2 0 0 0 2 2h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 10.3V7.2a2 2 0 0 0-2-2H6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronUp() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        d="M18 15l-6-6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChangeNavControls({
  total,
  currentIdx,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: ChangeNavControlsProps) {
  // Show a 1-based position, clamping the "above the first change" state
  // (currentIdx === -1, scrolled above change 1) to "1" rather than an em dash:
  // a "—" reads as broken (#486 review). prev stays disabled at the top via
  // canPrev, and pressing next from the top still scrolls to change 1.
  const position = Math.max(currentIdx, 0) + 1;
  const display = String(position);
  const announce = `change ${position} of ${total}`;
  return (
    <div className={styles.cluster} role="group" aria-label="Change navigation">
      <span className={styles.lead} aria-hidden>
        <ChangeNavIcon />
      </span>
      <button
        type="button"
        className={styles.chev}
        aria-label="Previous change"
        disabled={!canPrev}
        onClick={onPrev}
      >
        <ChevronUp />
      </button>
      <span className={styles.count}>
        {display} / {total}
      </span>
      <button
        type="button"
        className={styles.chev}
        aria-label="Next change"
        disabled={!canNext}
        onClick={onNext}
      >
        <ChevronDown />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
