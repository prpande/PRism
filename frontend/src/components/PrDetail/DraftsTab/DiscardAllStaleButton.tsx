import { useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { sendPatch } from '../../../api/draft';
import type { DraftCommentDto, DraftReplyDto, PrReference } from '../../../api/types';

interface DiscardAllStaleButtonProps {
  prRef: PrReference;
  staleComments: DraftCommentDto[];
  staleReplies: DraftReplyDto[];
}

const PREVIEW_LINES = 3;
const PREVIEW_LINE_CHARS = 80;

interface PreviewItem {
  id: string;
  label: string;
  body: string;
}

function firstLines(body: string, n: number): string {
  return body
    .split('\n')
    .slice(0, n)
    .map((line) =>
      line.length > PREVIEW_LINE_CHARS ? line.slice(0, PREVIEW_LINE_CHARS) + '…' : line,
    )
    .join('\n');
}

function buildPreviews(comments: DraftCommentDto[], replies: DraftReplyDto[]): PreviewItem[] {
  const head: PreviewItem[] = [];
  for (const c of comments) {
    if (head.length >= PREVIEW_LINES) break;
    const label = c.filePath
      ? `[thread on ${c.filePath}:${c.lineNumber ?? '?'}]`
      : '[PR-root thread]';
    head.push({ id: c.id, label, body: firstLines(c.bodyMarkdown, PREVIEW_LINES) });
  }
  for (const r of replies) {
    if (head.length >= PREVIEW_LINES) break;
    head.push({
      id: r.id,
      label: `[reply on ${r.parentThreadId}]`,
      body: firstLines(r.bodyMarkdown, PREVIEW_LINES),
    });
  }
  return head;
}

export function DiscardAllStaleButton({
  prRef,
  staleComments,
  staleReplies,
}: DiscardAllStaleButtonProps) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const total = staleComments.length + staleReplies.length;
  if (total === 0) return null;

  const previews = buildPreviews(staleComments, staleReplies);

  const handleConfirm = async () => {
    setRunning(true);
    // Per spec § 5.4, iterate deleteDraftComment / deleteDraftReply per id.
    // Sequential dispatch keeps the backend's per-PR write lock from queueing
    // a burst that can't be observed mid-flight; on the user side, the modal
    // stays open with both buttons disabled until the loop finishes (the
    // session refetch from the trailing `state-changed` SSE drops the rows).
    for (const c of staleComments) {
      const r = await sendPatch(prRef, {
        kind: 'deleteDraftComment',
        payload: { id: c.id },
      });
      if (!r.ok) console.warn('discard-all-stale: deleteDraftComment failed', c.id, r);
    }
    for (const reply of staleReplies) {
      const r = await sendPatch(prRef, {
        kind: 'deleteDraftReply',
        payload: { id: reply.id },
      });
      if (!r.ok) console.warn('discard-all-stale: deleteDraftReply failed', reply.id, r);
    }
    setRunning(false);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => setOpen(true)}
        disabled={running}
      >
        Discard all stale ({total})
      </button>
      <Modal
        open={open}
        title="Discard all stale drafts?"
        defaultFocus="cancel"
        onClose={() => {
          if (!running) setOpen(false);
        }}
      >
        <p>
          This will discard <strong>{total}</strong> stale draft{total === 1 ? '' : 's'}.
        </p>
        <ul className="discard-all-preview-list">
          {previews.map((p) => (
            <li key={p.id}>
              <span className="muted-2">{p.label}</span>
              <pre className="discard-all-preview-body">{p.body}</pre>
            </li>
          ))}
        </ul>
        <div className="modal-actions row gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            data-modal-role="cancel"
            onClick={() => setOpen(false)}
            disabled={running}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-modal-role="primary"
            onClick={() => void handleConfirm()}
            disabled={running}
          >
            Discard
          </button>
        </div>
      </Modal>
    </>
  );
}
