import type { ReviewSessionDto } from '../../api/types';

// In-flight-submit recovery surface (R3). `pendingReviewId` on the session is
// the persisted marker of an in-flight or interrupted submit: if a tester
// closed the tab or the process restarted mid-pipeline, this badge surfaces
// the state on reopen instead of silently relying on them clicking Submit
// Review again. Click → opens the SubmitDialog into the resume path.
interface Props {
  session: ReviewSessionDto;
  onResume(): void;
}

export function SubmitInProgressBadge({ session, onResume }: Props) {
  if (session.pendingReviewId === null) return null;
  return (
    <button type="button" className="submit-in-progress-badge chip chip-warning" onClick={onResume}>
      Submit in progress — Resume?
    </button>
  );
}
