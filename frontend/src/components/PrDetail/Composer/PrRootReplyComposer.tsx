import { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { Modal } from '../../Modal/Modal';
import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import type { PrReference } from '../../../api/types';

export interface PrRootReplyComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody?: string;
  // Controlled draftId. Parent (Overview tab) tracks this so it can hydrate
  // from `useDraftSession.draftComments` (anchor-less: filePath/lineNumber/
  // anchoredSha all null per spec § 5.6).
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string) => () => void;
  onClose: () => void;
  // Spec § 5.7a. Set when a peer tab claimed cross-tab ownership of this
  // PR. Disables the textarea and the action buttons; auto-save short-
  // circuits via useComposerAutoSave's `disabled` gate.
  readOnly?: boolean;
}

export function PrRootReplyComposer({
  prRef,
  prState,
  initialBody = '',
  draftId,
  onDraftIdChange,
  registerOpenComposer,
  onClose,
  readOnly = false,
}: PrRootReplyComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [previewMode, setPreviewMode] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
  const recoveryModalOpenRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const composerAnchor = { kind: 'pr-root' as const };

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
        kind: 'deleteDraftComment',
        payload: { id: draftId },
      });
      if (!result.ok) return;
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
    <div role="form" aria-label="Reply to this PR" className="pr-root-reply-composer">
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
          aria-label="PR reply body"
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
        <p>This will remove the saved PR reply draft.</p>
        <button type="button" data-modal-role="cancel" onClick={() => setDiscardModalOpen(false)}>
          Cancel
        </button>
        <button type="button" data-modal-role="primary" onClick={handleDiscardConfirm}>
          Discard
        </button>
      </Modal>

      <Modal
        open={recoveryModalOpen}
        title="PR reply draft deleted elsewhere"
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
