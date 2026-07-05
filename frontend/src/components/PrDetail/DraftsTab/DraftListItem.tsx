import { useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { sendPatch } from '../../../api/draft';
import type { DraftStatus, PrReference } from '../../../api/types';
import type { DraftLike } from '../draftKinds';
import styles from './DraftListItem.module.css';

interface DraftListItemProps {
  prRef: PrReference;
  draft: DraftLike;
  onEdit: (draft: DraftLike) => void;
  // useStateChangedSubscriber filters own-tab events, so a successful
  // sendPatch here does NOT trigger an automatic session refetch. The
  // owning DraftsTab passes its draftSession.refetch down so this
  // component can refresh the list itself.
  onMutated: () => void;
  // #744 — optimistic removal. Called with the draft id right after a
  // successful delete so the row leaves the list immediately, without waiting
  // for onMutated's reconciliation refetch to round-trip. Optional: omitting it
  // degrades gracefully to refetch-only (the pre-#744 behaviour).
  removeDraftLocally?: (id: string) => void;
  readOnly?: boolean;
}

const MODAL_PREVIEW_CHARS = 80;

function modalPreview(body: string): string {
  if (body.length <= MODAL_PREVIEW_CHARS) return body;
  return body.slice(0, MODAL_PREVIEW_CHARS).trimEnd() + '…';
}

function statusLabel(d: DraftLike): { text: string; modifier: string } {
  const status: DraftStatus = d.data.status;
  if (status === 'moved' && d.kind === 'comment') {
    const lineNo = d.data.lineNumber;
    return { text: `Moved${lineNo != null ? ` (line ${lineNo})` : ''}`, modifier: 'moved' };
  }
  if (status === 'stale') {
    return { text: 'Stale', modifier: 'stale' };
  }
  return { text: 'Draft', modifier: 'draft' };
}

export function DraftListItem({
  prRef,
  draft,
  onEdit,
  onMutated,
  removeDraftLocally,
  readOnly = false,
}: DraftListItemProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const status = statusLabel(draft);
  const body = draft.data.bodyMarkdown;

  const isOverridden = draft.data.isOverriddenStale === true;

  const requestDelete = () => {
    if (deleting) return;
    if (body.trim().length === 0) {
      void runDelete();
      return;
    }
    setConfirmOpen(true);
  };

  const runDelete = async () => {
    setDeleting(true);
    setConfirmOpen(false);
    const patch =
      draft.kind === 'comment'
        ? { kind: 'deleteDraftComment' as const, payload: { id: draft.data.id } }
        : { kind: 'deleteDraftReply' as const, payload: { id: draft.data.id } };
    const result = await sendPatch(prRef, patch);
    if (!result.ok) {
      // Match the MarkAllReadButton pattern: surface in DevTools without
      // yanking the user; inline error UX deferred to S6 polish.
      console.warn('delete-draft failed', result);
      setDeleting(false);
      return;
    }
    // #744 — optimistic removal keyed on server-confirmed success: splice the
    // row out locally now so it clears instantly, before onMutated's refetch
    // round-trips. Keyed on success, so the trailing refetch (server no longer
    // returns this id) cannot resurrect it.
    removeDraftLocally?.(draft.data.id);
    // Own-tab state-changed events are filtered (spec § 5.7), so we have
    // to drive the refetch ourselves. Re-enable the buttons immediately so
    // the user is not stuck behind a permanent disabled state if refetch
    // is slow or fails.
    setDeleting(false);
    onMutated();
  };

  return (
    <div className={`draft-list-item ${styles.draftListItem}`}>
      <div className={`draft-list-item-header ${styles.draftBand}`}>
        <span className={`chip chip-status-${status.modifier}`}>{status.text}</span>
        {isOverridden && <span className="chip chip-override">User-overridden (was Stale)</span>}
        {draft.kind === 'comment' && draft.data.filePath != null && (
          <span className={styles.fileref}>
            {draft.data.filePath}
            {/* The "moved" chip already reads "Moved (line N)", so suppress the
                band's redundant line suffix for that variant only. */}
            {draft.data.lineNumber != null && status.modifier !== 'moved' && (
              <span className={styles.fileRefLine}> · line {draft.data.lineNumber}</span>
            )}
          </span>
        )}
      </div>
      <div className={`draft-list-item-preview ${styles.draftBody}`}>
        <MarkdownRenderer source={body} />
      </div>
      {!readOnly && (
        <div className={`draft-list-item-actions ${styles.draftFooter}`}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onEdit(draft)}
            disabled={deleting}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={requestDelete}
            disabled={deleting}
          >
            Discard
          </button>
        </div>
      )}

      {/* readOnly: the Discard button (Modal's only trigger) is gated above, so
          confirmOpen stays false and this Modal is unreachable while readOnly. */}
      <Modal
        open={confirmOpen}
        title="Discard this draft?"
        defaultFocus="cancel"
        onClose={() => setConfirmOpen(false)}
      >
        <p className="muted">{modalPreview(body)}</p>
        <div className="modal-actions row gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            data-modal-role="cancel"
            onClick={() => setConfirmOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-modal-role="primary"
            onClick={() => void runDelete()}
          >
            Discard
          </button>
        </div>
      </Modal>
    </div>
  );
}
