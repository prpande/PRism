import { Modal } from '../Modal/Modal';
import styles from './DiscardPendingReviewConfirmationModal.module.css';

// Spec § 4.10: shared confirmation before discarding the in-flight/pending
// review on GitHub. Used by two surfaces — the SubmitDialog footer Discard
// button (T22) and the PrHeader pending-review pill (T24). Mirrors
// DiscardAllConfirmationModal: shared <Modal> shell (480px default),
// defaultFocus="cancel" so the user opts into destruction, btn-danger primary.
//
// Presentational only: the parent owns the discardOwnPendingReview call and
// passes onDiscard + discardInFlight + errorMessage. Esc closes UNLESS a
// discard is in flight (disableEscDismiss tied to discardInFlight).

interface DiscardPendingReviewConfirmationModalProps {
  open: boolean;
  // Cancel/Close + Esc/overlay dismiss — the modal's close.
  onCancel: () => void;
  // Discard/Retry action — kicks off discardOwnPendingReview in the parent.
  onDiscard: () => void;
  // True while the endpoint call is running: action shows a spinner + is
  // disabled, the Cancel button is hidden, and Esc no longer dismisses.
  discardInFlight: boolean;
  // Set → Failure state: action becomes "Retry", Cancel becomes "Close",
  // and the error row is shown.
  errorMessage?: string | null;
}

export function DiscardPendingReviewConfirmationModal({
  open,
  onCancel,
  onDiscard,
  discardInFlight,
  errorMessage,
}: DiscardPendingReviewConfirmationModalProps) {
  if (!open) return null;

  const hasError = !discardInFlight && !!errorMessage;
  const actionLabel = discardInFlight ? 'Discarding…' : hasError ? 'Retry' : 'Discard';
  const cancelLabel = hasError ? 'Close' : 'Cancel';

  return (
    <Modal
      open
      title="Discard pending review on GitHub?"
      onClose={onCancel}
      defaultFocus="cancel"
      disableEscDismiss={discardInFlight}
    >
      <div className={styles.discardPendingReviewModal} data-testid="discard-pending-review-modal">
        <ul className={styles.bullets}>
          <li>The pending review on GitHub will be deleted, along with its threads.</li>
          <li>Your PRism drafts and replies will be unstamped, ready to submit fresh.</li>
        </ul>

        {hasError && (
          <div role="alert" data-testid="discard-pending-error" className={styles.error}>
            Couldn't discard: {errorMessage}.
          </div>
        )}

        <footer className={styles.footer}>
          {!discardInFlight && (
            <button
              type="button"
              className="btn btn-secondary"
              data-modal-role="cancel"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger"
            data-testid="confirm-discard-pending"
            disabled={discardInFlight}
            aria-disabled={discardInFlight || undefined}
            onClick={onDiscard}
          >
            {discardInFlight && <span className={styles.spinner} aria-hidden="true" />}
            {actionLabel}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
