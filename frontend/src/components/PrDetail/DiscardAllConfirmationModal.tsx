import { Modal } from '../Modal/Modal';

// Spec § 13.1: confirmation before the closed/merged-PR bulk discard. Destructive
// — defaultFocus on Cancel (the discard-saved-draft precedent, spec § 5.5a),
// btn-danger primary, Esc dismisses to Cancel. Width: the shared .modal-dialog
// 480px default (spec § 8.5).

interface Props {
  open: boolean;
  // 'closed' or 'merged' — the bulk-discard button only surfaces on those, so
  // the copy names the actual state rather than the spec's literal "closed PR".
  prState: 'closed' | 'merged';
  threadCount: number;
  replyCount: number;
  onConfirm(): void;
  onCancel(): void;
}

export function DiscardAllConfirmationModal({
  open,
  prState,
  threadCount,
  replyCount,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;
  return (
    <Modal open title="Discard all drafts?" onClose={onCancel} defaultFocus="cancel">
      <div className="discard-all-confirmation-modal">
        <p>
          Discard {threadCount} draft(s) and {replyCount} reply(ies) on this {prState} PR? This
          cannot be undone.
        </p>
        <footer className="discard-all-confirmation-modal__footer">
          <button
            type="button"
            className="btn btn-secondary"
            data-modal-role="cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            Discard all
          </button>
        </footer>
      </div>
    </Modal>
  );
}
