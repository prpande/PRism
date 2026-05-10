import { useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { sendPatch } from '../../../api/draft';
import type { DraftCommentDto, DraftReplyDto, DraftStatus, PrReference } from '../../../api/types';

type DraftLike =
  | { kind: 'comment'; data: DraftCommentDto }
  | { kind: 'reply'; data: DraftReplyDto };

interface DraftListItemProps {
  prRef: PrReference;
  draft: DraftLike;
  onEdit: (draft: DraftLike) => void;
}

const PREVIEW_CHARS = 80;

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

function previewBody(body: string): string {
  if (body.length <= PREVIEW_CHARS) return body;
  return body.slice(0, PREVIEW_CHARS).trimEnd() + '…';
}

export function DraftListItem({ prRef, draft, onEdit }: DraftListItemProps) {
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
    }
    // On success the parent's session refetch (via `state-changed` SSE)
    // will drop the row, so we leave `deleting=true` rather than flicker.
  };

  return (
    <div className="draft-list-item">
      <div className="draft-list-item-header row gap-2">
        <span className={`chip chip-status-${status.modifier}`}>{status.text}</span>
        {isOverridden && <span className="chip chip-override">User-overridden (was Stale)</span>}
        {draft.kind === 'comment' && draft.data.lineNumber != null && (
          <span className="muted-2">line {draft.data.lineNumber}</span>
        )}
      </div>
      <div className="draft-list-item-preview">
        <MarkdownRenderer source={previewBody(body)} />
      </div>
      <div className="draft-list-item-actions row gap-2">
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
          Delete
        </button>
      </div>

      <Modal
        open={confirmOpen}
        title="Discard this draft?"
        defaultFocus="cancel"
        onClose={() => setConfirmOpen(false)}
      >
        <p className="muted">{previewBody(body)}</p>
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

export type { DraftLike };
