import { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { Modal } from '../../Modal/Modal';
import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import type { PrReference } from '../../../api/types';

export interface ReplyComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  parentThreadId: string;
  initialBody?: string;
  // Controlled draftId. The parent (thread renderer) tracks this so it can
  // hydrate the composer body from `useDraftSession.draftReplies` and decide
  // whether to mount a fresh composer or rehydrate an in-progress reply.
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  // Provided by useDraftSession; refcount registry keeps the diff-and-prefer
  // merge from clobbering this composer's local body.
  registerOpenComposer: (draftId: string) => () => void;
  // Dismissed by the parent — used after Cmd+Enter, after a successful empty-
  // body delete, after the 404-recovery "Discard" choice, and after the
  // discard-modal "Discard" confirmation.
  onClose: () => void;
  // Spec § 5.7a. Set when a peer tab claimed cross-tab ownership of this
  // PR. Disables the textarea and the action buttons; auto-save short-
  // circuits via useComposerAutoSave's `disabled` gate.
  readOnly?: boolean;
}

function replyAriaLabel(parentThreadId: string): string {
  return `Reply to thread ${parentThreadId}`;
}

export function ReplyComposer({
  prRef,
  prState,
  parentThreadId,
  initialBody = '',
  draftId,
  onDraftIdChange,
  registerOpenComposer,
  onClose,
  readOnly = false,
}: ReplyComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [previewMode, setPreviewMode] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);

  // Mirrors recoveryModalOpen synchronously so Cmd+Enter's flush()→onClose()
  // sequence can detect a 404-recovery transition that opened mid-flush.
  const recoveryModalOpenRef = useRef(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const composerAnchor = {
    kind: 'reply' as const,
    parentThreadId,
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

  useEffect(() => {
    if (draftId === null) return;
    return registerOpenComposer(draftId);
  }, [draftId, registerOpenComposer]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const trimmedLength = body.trim().length;
  const bodyEmpty = trimmedLength === 0;
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
      const result = await sendPatch(prRef, {
        kind: 'deleteDraftReply',
        payload: { id: draftId },
      });
      if (!result.ok) {
        // Backend rejection or network failure — keep the modal open so the
        // user knows the discard didn't take effect. Mirrors PR4's
        // InlineCommentComposer.handleDiscardConfirm post-no-throw refactor.
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
    await flush();
  };

  const handleRecoveryDiscard = () => {
    recoveryModalOpenRef.current = false;
    setRecoveryModalOpen(false);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      setPreviewMode((p) => !p);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void (async () => {
        await flush();
        if (recoveryModalOpenRef.current) return;
        onClose();
      })();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDiscardClick();
      return;
    }
  };

  const closedBanner = prState !== 'open';

  return (
    <div role="form" aria-label={replyAriaLabel(parentThreadId)} className="reply-composer">
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
          aria-label="Reply body"
          rows={3}
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
        <p>This will remove the saved reply draft on this thread.</p>
        <button type="button" data-modal-role="cancel" onClick={() => setDiscardModalOpen(false)}>
          Cancel
        </button>
        <button type="button" data-modal-role="primary" onClick={handleDiscardConfirm}>
          Discard
        </button>
      </Modal>

      <Modal
        open={recoveryModalOpen}
        title="Draft reply deleted elsewhere"
        defaultFocus="primary"
        disableEscDismiss
        onClose={() => setRecoveryModalOpen(false)}
      >
        <p>
          This reply draft was deleted from another window or by reload. Re-create it with the
          current text, or discard?
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
