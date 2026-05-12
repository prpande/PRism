import type { DraftVerdict, DraftVerdictStatus } from '../../api/types';

// Segmented control, three slots (spec § 10). Lives in both the header and the
// Submit dialog; both bind to the session's `draftVerdict`. Clicking the
// already-selected slot clears the verdict (onChange(null)) — the PR3
// JsonElement patch shape makes the clear round-trip.
interface Props {
  value: DraftVerdict | null;
  verdictStatus?: DraftVerdictStatus;
  // Frozen during the pipeline run (spec § 8.3) — and disabled in the header
  // while the dialog is in-flight.
  disabled?: boolean;
  onChange(verdict: DraftVerdict | null): void;
}

const SEGMENTS: { value: DraftVerdict; label: string }[] = [
  { value: 'approve', label: 'Approve' },
  { value: 'request-changes', label: 'Request changes' },
  { value: 'comment', label: 'Comment' },
];

export function VerdictPicker({ value, verdictStatus, disabled, onChange }: Props) {
  return (
    <div className="verdict-picker">
      <div className="verdict-picker__segments" role="group" aria-label="Review verdict">
        {SEGMENTS.map((seg) => {
          const selected = value === seg.value;
          return (
            <button
              key={seg.value}
              type="button"
              className={`verdict-picker__segment${selected ? ' verdict-picker__segment--selected' : ''}`}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(selected ? null : seg.value)}
            >
              {seg.label}
            </button>
          );
        })}
      </div>
      {verdictStatus === 'needs-reconfirm' && (
        <span className="verdict-picker__status chip chip-warning">Needs reconfirm</span>
      )}
    </div>
  );
}
