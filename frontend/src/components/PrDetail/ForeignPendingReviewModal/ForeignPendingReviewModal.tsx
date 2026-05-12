import { useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { DiscardConfirmationSubModal } from './DiscardConfirmationSubModal';
import type { SubmitForeignPendingReviewEvent } from '../../../api/types';

// Spec § 11: surfaced when POST /submit returns ForeignPendingReviewPromptRequired
// (useSubmit.state.kind === 'foreign-pending-review-prompt'). Three choices:
// Resume (import the foreign review's threads as Draft entries for adjudication),
// Discard (delete it on github.com after a second-tier confirmation), or Cancel
// (no server change). Counts come from the SSE snapshot (Snapshot A).
//
// a11y (spec § 11): uses the shared <Modal> (role="dialog" + aria-modal +
// aria-labelledby + FocusTrap), defaultFocus on Cancel (the non-destructive
// choice), and — unlike SubmitDialog — Esc dismisses to Cancel (R14:
// disableEscDismiss=false). Width: the shared .modal-dialog's 480px default
// (spec § 8.5) applies; no .submit-dialog child so the 720px override doesn't.

interface Props {
  open: boolean;
  snapshot: SubmitForeignPendingReviewEvent;
  onResume(pullRequestReviewId: string): void;
  onDiscard(pullRequestReviewId: string): void;
  onCancel(): void;
}

export function ForeignPendingReviewModal({
  open,
  snapshot,
  onResume,
  onDiscard,
  onCancel,
}: Props) {
  const [discardOpen, setDiscardOpen] = useState(false);

  if (!open) return null;

  const humanized = new Date(snapshot.createdAt).toLocaleString();

  return (
    <>
      {/* While the destructive sub-modal is up, the primary modal steps aside
          so there's only ever one <Modal> (one backdrop, one focus trap). */}
      <Modal
        open={!discardOpen}
        title="Existing pending review on this PR"
        onClose={onCancel}
        defaultFocus="cancel"
      >
        <div className="foreign-prr-modal">
          <p className="foreign-prr-modal__body">
            You have a pending review on this PR from {humanized}. It contains{' '}
            <strong>{snapshot.threadCount} thread(s)</strong> and{' '}
            <strong>{snapshot.replyCount} reply(ies)</strong>. Resume it (you&rsquo;ll see the
            contents before submit), discard it and start fresh, or cancel?
          </p>
          <footer className="foreign-prr-modal__footer">
            <button
              type="button"
              className="btn btn-secondary"
              data-modal-role="cancel"
              onClick={onCancel}
            >
              Cancel — your local drafts and the pending review on GitHub are unchanged.
            </button>
            <button type="button" className="btn" onClick={() => setDiscardOpen(true)}>
              Discard…
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onResume(snapshot.pullRequestReviewId)}
            >
              Resume
            </button>
          </footer>
        </div>
      </Modal>
      <DiscardConfirmationSubModal
        open={discardOpen}
        threadCount={snapshot.threadCount}
        replyCount={snapshot.replyCount}
        onConfirm={() => {
          setDiscardOpen(false);
          onDiscard(snapshot.pullRequestReviewId);
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </>
  );
}
