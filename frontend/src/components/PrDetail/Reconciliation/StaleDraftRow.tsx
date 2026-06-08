import { useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { sendPatch } from '../../../api/draft';
import type { PrReference, DraftSuggestion } from '../../../api/types';
import type { DraftLike } from '../draftKinds';
import type { PrTabId } from '../PrSubTabStrip';
import { SampleBadge } from '../../Ai/SampleBadge';
import styles from './StaleDraftRow.module.css';

// StaleDraftRow operates on the same shape as DraftListItem — see
// `../draftKinds.ts` for the canonical alias.
type StaleDraft = DraftLike;

interface StaleDraftRowProps {
  prRef: PrReference;
  draft: StaleDraft;
  // Own-tab state-changed events are filtered (spec § 5.7), so the
  // panel must drive the refetch itself after a successful mutation.
  onMutated: () => void;
  // PR9b-ai-gating § 4.5 — D48 closure. AI draft suggestion matching
  // this draft's (filePath, lineNumber) anchor. Null when gate is off,
  // when no suggestion matches, or when draft is a reply (no anchor).
  aiSuggestion: DraftSuggestion | null;
  // Switches the active sub-tab. Threaded as an explicit prop (not read
  // from PrDetailContext) because UnresolvedPanel → StaleDraftRow is
  // always-visible chrome that renders BEFORE the data-gated provider
  // exists. Reading the context here threw "must be used inside
  // PrDetailContextProvider" during the pre-load window and tore the app
  // down to the ErrorBoundary. See keep-alive deferrals § Step 3b.
  onSelectSubTab: (tab: PrTabId) => void;
}

const PREVIEW_CHARS = 80;

function previewBody(body: string): string {
  if (body.length <= PREVIEW_CHARS) return body;
  return body.slice(0, PREVIEW_CHARS).trimEnd() + '…';
}

export function StaleDraftRow({
  prRef,
  draft,
  onMutated,
  aiSuggestion,
  onSelectSubTab,
}: StaleDraftRowProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const body = draft.data.bodyMarkdown;

  const filePath = draft.kind === 'comment' ? draft.data.filePath : null;
  const lineNumber = draft.kind === 'comment' ? draft.data.lineNumber : null;

  // FilesTab does not currently consume `:filePath/*` splat or `?line=`
  // (deferrals doc § "FilesTab URL→state hydration deferred"). Switch to
  // the bare Files tab and let the user pick the file manually for now.
  // Lift when FilesTab gains the deep-link mechanic spec § 5.4 describes.
  const handleShowMe = () => {
    if (filePath != null) {
      onSelectSubTab('files');
      return;
    }
    // PR-root drafts and replies route to the Overview tab.
    onSelectSubTab('overview');
  };

  const handleEdit = () => handleShowMe();

  const requestDelete = () => {
    if (busy) return;
    if (body.trim().length === 0) {
      void runDelete();
      return;
    }
    setConfirmOpen(true);
  };

  const runDelete = async () => {
    setBusy(true);
    setConfirmOpen(false);
    const patch =
      draft.kind === 'comment'
        ? { kind: 'deleteDraftComment' as const, payload: { id: draft.data.id } }
        : { kind: 'deleteDraftReply' as const, payload: { id: draft.data.id } };
    const result = await sendPatch(prRef, patch);
    setBusy(false);
    if (!result.ok) {
      console.warn('stale-row delete failed', result);
      return;
    }
    onMutated();
  };

  const handleKeepAnyway = async () => {
    if (busy) return;
    setBusy(true);
    const result = await sendPatch(prRef, {
      kind: 'overrideStale',
      payload: { id: draft.data.id },
    });
    setBusy(false);
    if (!result.ok) {
      console.warn('overrideStale failed', result);
      return;
    }
    onMutated();
  };

  const anchorLabel =
    filePath != null && lineNumber != null
      ? `${filePath}:${lineNumber}`
      : draft.kind === 'reply'
        ? `reply on ${draft.data.parentThreadId}`
        : 'PR-root';

  return (
    <li className={`stale-draft-row row gap-2 ${styles.staleDraftRow}`}>
      <span className="chip chip-status-stale">Stale</span>
      <span className={`muted-2 stale-draft-row-anchor ${styles.staleDraftRowAnchor}`}>
        {anchorLabel}
      </span>
      <span className={`stale-draft-row-preview ${styles.staleDraftRowPreview}`}>
        {previewBody(body)}
      </span>
      {aiSuggestion && (
        <div
          className={`stale-ai ai-tint ${styles.staleAi}`}
          data-testid="stale-draft-ai-suggestion"
        >
          <span className="ai-icon" aria-hidden="true">
            ✨
          </span>
          <div className={styles.staleAiBody}>
            <div className={`ai-summary-label ${styles.staleAiLabel}`}>
              AI suggestion <SampleBadge />
            </div>
            <div>{aiSuggestion.body}</div>
          </div>
        </div>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={handleShowMe}
        disabled={busy}
      >
        Show me
      </button>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={handleEdit}
        disabled={busy}
      >
        Edit
      </button>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={requestDelete}
        disabled={busy}
      >
        Delete
      </button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => void handleKeepAnyway()}
        disabled={busy}
      >
        Keep anyway
      </button>

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
    </li>
  );
}
