import { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { Modal } from '../../Modal/Modal';
import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import type { DraftSide, PrReference } from '../../../api/types';

export interface InlineAnchor {
  filePath: string;
  lineNumber: number;
  side: DraftSide;
  anchoredSha: string;
  anchoredLineContent: string;
}

export interface InlineCommentComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  anchor: InlineAnchor;
  initialBody?: string;
  // Controlled draftId. The parent (FilesTab) tracks this so it can decide
  // whether to surface the A2 transition modal on a click-to-another-line.
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  // Provided by useDraftSession; refcount registry keeps the diff-and-prefer
  // merge from clobbering this composer's local body.
  registerOpenComposer: (draftId: string) => () => void;
  // Dismissed by the parent (FilesTab) — used after Cmd+Enter, after a
  // successful empty-body delete, after the 404-recovery "Discard" choice,
  // and after the discard-modal "Discard" confirmation.
  onClose: () => void;
  // Spec § 5.7a. Set when a peer tab claimed cross-tab ownership of this
  // PR. Disables the textarea and the action buttons; auto-save short-
  // circuits via useComposerAutoSave's `disabled` gate.
  readOnly?: boolean;
}

function composerAriaLabel(anchor: InlineAnchor): string {
  return `Draft comment on ${anchor.filePath} line ${anchor.lineNumber}`;
}

export function InlineCommentComposer({
  prRef,
  prState,
  anchor,
  initialBody = '',
  draftId,
  onDraftIdChange,
  registerOpenComposer,
  onClose,
  readOnly = false,
}: InlineCommentComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [previewMode, setPreviewMode] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);

  // Mirrors recoveryModalOpen synchronously so Cmd+Enter's flush()→onClose()
  // sequence can detect a 404-recovery transition that opened mid-flush
  // (state updates aren't visible until the next render but the ref is).
  const recoveryModalOpenRef = useRef(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const composerAnchor = {
    kind: 'inline-comment' as const,
    filePath: anchor.filePath,
    lineNumber: anchor.lineNumber,
    side: anchor.side,
    anchoredSha: anchor.anchoredSha,
    anchoredLineContent: anchor.anchoredLineContent,
  };

  const handleAssignedId = useCallback(
    (id: string) => {
      onDraftIdChange(id);
    },
    [onDraftIdChange],
  );

  const handleDraftDeletedByServer = useCallback(() => {
    onDraftIdChange(null);
    recoveryModalOpenRef.current = true;
    setRecoveryModalOpen(true);
  }, [onDraftIdChange]);

  const handleLocalDelete = useCallback(() => {
    onDraftIdChange(null);
    onClose();
  }, [onClose, onDraftIdChange]);

  const { badge, flush } = useComposerAutoSave({
    prRef,
    prState,
    body,
    draftId,
    anchor: composerAnchor,
    onAssignedId: handleAssignedId,
    onDraftDeletedByServer: handleDraftDeletedByServer,
    onLocalDelete: handleLocalDelete,
    disabled: readOnly,
  });

  // Keep the merge predicate truthy for as long as this composer is mounted
  // for a persisted draft. The refcount handles the rare case where two
  // composers (Files + Drafts tabs) open the same draft id simultaneously.
  useEffect(() => {
    if (draftId === null) return;
    return registerOpenComposer(draftId);
  }, [draftId, registerOpenComposer]);

  // Auto-focus the textarea on mount so the user can start typing
  // immediately after clicking a diff line.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const trimmedLength = body.trim().length;
  const bodyEmpty = trimmedLength === 0;
  // Creation threshold gate (spec § 5.3): a brand-new draft (`draftId`
  // is null) needs ≥3 chars before it can be persisted. For an existing
  // draft, sub-threshold edits are valid updates per § 5.4.
  const belowCreateThreshold = draftId === null && trimmedLength < COMPOSER_CREATE_THRESHOLD;
  const saveDisabled = bodyEmpty || belowCreateThreshold || readOnly;
  const saveTooltip = readOnly
    ? 'Another tab is editing this PR.'
    : bodyEmpty
      ? 'Type something to save.'
      : belowCreateThreshold
        ? `Type at least ${COMPOSER_CREATE_THRESHOLD} characters to save.`
        : undefined;

  const handleDiscardClick = () => {
    if (draftId === null) {
      onClose();
      return;
    }
    setDiscardModalOpen(true);
  };

  const handleDiscardConfirm = async () => {
    if (draftId !== null) {
      let result;
      try {
        result = await sendPatch(prRef, {
          kind: 'deleteDraftComment',
          payload: { id: draftId },
        });
      } catch {
        // Network / non-ApiError. Stay in the modal so the user can retry
        // — closing on failure would optimistically appear that the draft
        // was discarded when the server still has it.
        return;
      }
      if (!result.ok) {
        // Backend rejection (404 / 422 / 409 / 5xx). Keep the modal open
        // so the user knows the discard didn't take effect; FilesTab's
        // refetch-on-close path can't recover this since we didn't close.
        return;
      }
      onDraftIdChange(null);
    }
    setDiscardModalOpen(false);
    onClose();
  };

  const handleSaveClick = async () => {
    if (saveDisabled) return;
    await flush();
  };

  const handleRecoveryRecreate = async () => {
    recoveryModalOpenRef.current = false;
    setRecoveryModalOpen(false);
    // draftId was cleared by onDraftDeletedByServer. flush() with current
    // body (>= 3 chars) re-fires create through useComposerAutoSave.
    await flush();
  };

  const handleRecoveryDiscard = () => {
    recoveryModalOpenRef.current = false;
    setRecoveryModalOpen(false);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Shift+P → toggle preview.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      setPreviewMode((p) => !p);
      return;
    }
    // Cmd/Ctrl+Enter → flush + close.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void (async () => {
        await flush();
        // If the flush triggered a 404 recovery, the modal is now open and
        // expects the user to choose Re-create / Discard. Skip onClose so
        // the modal doesn't get unmounted out from under them.
        if (recoveryModalOpenRef.current) return;
        onClose();
      })();
      return;
    }
    // Esc → discard flow.
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDiscardClick();
      return;
    }
  };

  const closedBanner = prState !== 'open';

  return (
    <div role="form" aria-label={composerAriaLabel(anchor)} className="inline-comment-composer">
      {closedBanner && (
        <div className="composer-closed-banner muted" role="status">
          PR {prState === 'closed' ? 'closed' : 'merged'} — text not saved
        </div>
      )}

      {previewMode ? (
        <ComposerMarkdownPreview body={body} />
      ) : (
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Comment body"
          rows={4}
          readOnly={readOnly}
          aria-readonly={readOnly || undefined}
        />
      )}

      <div className="composer-actions">
        <button
          type="button"
          className="composer-preview-toggle"
          aria-pressed={previewMode}
          onClick={() => setPreviewMode((p) => !p)}
        >
          {previewMode ? 'Edit' : 'Preview'}
        </button>

        <span className={`composer-badge composer-badge--${badge}`} role="status">
          {badge}
        </span>

        <AiComposerAssistant />

        <button
          type="button"
          className="composer-discard"
          onClick={handleDiscardClick}
          disabled={readOnly}
          aria-disabled={readOnly || undefined}
        >
          Discard
        </button>

        <button
          type="button"
          className="composer-save"
          aria-disabled={saveDisabled}
          title={saveTooltip}
          onClick={handleSaveClick}
          disabled={readOnly}
        >
          Save
        </button>
      </div>

      <Modal
        open={discardModalOpen}
        title="Discard saved draft?"
        defaultFocus="cancel"
        onClose={() => setDiscardModalOpen(false)}
      >
        <p>This will remove the saved draft on this line.</p>
        <button type="button" data-modal-role="cancel" onClick={() => setDiscardModalOpen(false)}>
          Cancel
        </button>
        <button type="button" data-modal-role="primary" onClick={handleDiscardConfirm}>
          Discard
        </button>
      </Modal>

      <Modal
        open={recoveryModalOpen}
        title="Draft deleted elsewhere"
        defaultFocus="primary"
        disableEscDismiss
        onClose={() => setRecoveryModalOpen(false)}
      >
        <p>
          This draft was deleted from another window or by reload. Re-create it with the current
          text, or discard?
        </p>
        <button type="button" data-modal-role="cancel" onClick={handleRecoveryDiscard}>
          Discard
        </button>
        <button type="button" data-modal-role="primary" onClick={handleRecoveryRecreate}>
          Re-create
        </button>
      </Modal>
    </div>
  );
}
