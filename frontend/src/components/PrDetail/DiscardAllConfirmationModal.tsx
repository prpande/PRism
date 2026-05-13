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
  // The bulk-discard button also surfaces when the *only* leftover is a draft
  // summary or a stale pendingReviewId — name those in the copy so it doesn't
  // read "0 draft(s) and 0 reply(ies)" when something is in fact being removed.
  hasSummary?: boolean;
  hasPendingReview?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

function discardedItems(
  threadCount: number,
  replyCount: number,
  hasSummary: boolean,
  hasPendingReview: boolean,
): string {
  const parts: string[] = [];
  if (threadCount > 0) parts.push(`${threadCount} draft comment${threadCount === 1 ? '' : 's'}`);
  if (replyCount > 0) parts.push(`${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`);
  if (hasSummary) parts.push('your draft summary');
  if (hasPendingReview) parts.push('the pending review on GitHub');
  if (parts.length === 0) return 'all local review state';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function DiscardAllConfirmationModal({
  open,
  prState,
  threadCount,
  replyCount,
  hasSummary = false,
  hasPendingReview = false,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;
  const items = discardedItems(threadCount, replyCount, hasSummary, hasPendingReview);
  return (
    <Modal open title="Discard all drafts?" onClose={onCancel} defaultFocus="cancel">
      <div className="discard-all-confirmation-modal">
        <p>
          Discard everything still on this {prState} PR? This permanently removes {items}. This
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
