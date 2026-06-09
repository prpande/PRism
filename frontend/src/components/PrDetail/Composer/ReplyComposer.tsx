import { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { postComment } from '../../../api/comment';
import { Modal } from '../../Modal/Modal';
import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import styles from './ReplyComposer.module.css';
import type { PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';

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
  // Provided by useDraftSession; set-based registry keeps the diff-and-prefer
  // merge from clobbering this composer's local body.
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  // Dismissed by the parent — used after Cmd+Enter, after a successful empty-
  // body delete, after the 404-recovery "Discard" choice, and after the
  // discard-modal "Discard" confirmation.
  onClose: () => void;
  // Spec § 5.7a. Set when a peer tab claimed cross-tab ownership of this
  // PR. Disables the textarea and the action buttons; auto-save short-
  // circuits via useComposerAutoSave's `disabled` gate.
  readOnly?: boolean;
  // #302 — post-now support. Optional (Task 11 wires them; defaults preserve
  // the existing call-sites with zero changes).
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  // #302 Task 11b — carries the posted body so the parent can render an
  // optimistic placeholder card immediately (before the refetch lands).
  onPosted?: (postedCommentId: number, body: string) => void;
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
  anyOtherDraftsStaged = false,
  beginPosting,
  endPosting,
  onPosted,
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
    return registerOpenComposer(draftId, 'files-tab');
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

  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  // Post-now derived values
  const postNowDisabled = saveDisabled || posting || anyOtherDraftsStaged;
  const postNowTooltip = anyOtherDraftsStaged
    ? 'You have a review in progress — submit or discard it to post a single comment.'
    : saveTooltip;

  const handlePostNow = async () => {
    if (postNowDisabled) return;
    setPostError(null);
    setPosting(true);
    beginPosting?.();                            // synchronous, BEFORE flush (no flicker)
    try {
      const id = (await flush()) ?? draftId;     // id assigned during flush; prop is stale
      if (!id) { setPostError('Could not save the draft. Try again.'); return; }
      const res = await postComment(prRef, id);
      if (res.ok) { onPosted?.(res.postedCommentId, body); onClose(); }
      else { setPostError(res.message); }
    } finally {
      // Safe even when onClose() above triggers unmount: endPosting is an
      // idempotent ref-counter decrement (balanced 1:1 with beginPosting),
      // and setPosting after unmount is a React-18 no-op.
      setPosting(false); endPosting?.();
    }
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

  // Post-now footer logic (#302 Task 10)
  const addLabel = anyOtherDraftsStaged ? 'Add review comment' : 'Add to review';

  return (
    <div
      role="form"
      aria-label={replyAriaLabel(parentThreadId)}
      data-composer="true"
      data-testid="reply-composer"
      className={`reply-composer composer-frame ${styles.replyComposer}`}
    >
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

        <span
          className={`composer-badge composer-badge--${badge}`}
          role="status"
          data-testid="composer-badge"
        >
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

        {!closedBanner && (
          <button
            type="button"
            className="composer-save btn btn-primary btn-sm"
            aria-disabled={saveDisabled}
            title={saveTooltip}
            onClick={handleSaveClick}
            disabled={readOnly}
          >
            {addLabel}
          </button>
        )}
        <button
          type="button"
          className="composer-post-now"
          aria-disabled={postNowDisabled}
          title={postNowTooltip}
          onClick={handlePostNow}
          disabled={readOnly || posting}
        >
          {posting ? 'Posting…' : 'Comment'}
        </button>
        {closedBanner && (
          <span className="composer-merged-note">
            {prState === 'closed' ? 'PR is closed' : 'PR is merged'} — comments post immediately
          </span>
        )}
        {postError && (
          <div className="composer-error" role="alert">{postError}</div>
        )}
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
