import { Modal } from '../../Modal/Modal';

// Spec § 11.2: second-tier confirmation before deleting a foreign pending review
// on github.com. Destructive — defaultFocus on Cancel (the discard-saved-draft
// precedent, spec § 5.5a) and a btn-danger primary. Esc dismisses to Cancel
// (returns to the primary ForeignPendingReviewModal). Width: the shared
// .modal-dialog 480px default (spec § 8.5).

interface Props {
  open: boolean;
  threadCount: number;
  replyCount: number;
  onConfirm(): void;
  onCancel(): void;
}

export function DiscardConfirmationSubModal({
  open,
  threadCount,
  replyCount,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;
  return (
    <Modal
      open
      title="Delete the pending review on github.com?"
      onClose={onCancel}
      defaultFocus="cancel"
    >
      <div className="discard-confirmation-sub-modal">
        <p>
          Its {threadCount} thread(s) and {replyCount} reply(ies) will be permanently removed. This
          cannot be undone.
        </p>
        <footer className="discard-confirmation-sub-modal__footer">
          <button
            type="button"
            className="btn btn-secondary"
            data-modal-role="cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            Delete
          </button>
        </footer>
      </div>
    </Modal>
  );
}
