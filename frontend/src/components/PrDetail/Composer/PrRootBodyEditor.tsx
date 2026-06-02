import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './PrRootBodyEditor.module.css';
import { useComposerAutoSave, type ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';
import { Modal } from '../../Modal/Modal';
import type { PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';

export interface PrRootBodyEditorProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody: string;
  // Controlled draftId (owned by the consumer — composer or SubmitDialog).
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  // Task 19 2-arg signature: claims cross-tab ownership for the given draft.
  // Returns an unregister callback the editor runs on cleanup.
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey: ComposerOwnerKey;
  // Cross-tab take-over yields this surface to read-only (spec § 5.7a). Auto-
  // save short-circuits via useComposerAutoSave's `disabled` gate.
  readOnly?: boolean;
  // Surfaces the live body to the consumer so it can drive Post / preview.
  onBodyChange?: (body: string) => void;
  // Surfaces the autosave controls so the consumer can flush before Post and
  // mirror the badge into its own action bar.
  onAutosaveControl?: (control: { flush: () => Promise<void>; badge: ComposerSaveBadge }) => void;
  // Fired when the user discards from the 404-recovery modal. The consumer
  // decides what to do (composer closes; SubmitDialog clears its editor).
  onDraftLost?: () => void;
}

export function PrRootBodyEditor({
  prRef,
  prState,
  initialBody,
  draftId,
  onDraftIdChange,
  registerOpenComposer,
  ownerKey,
  readOnly = false,
  onBodyChange,
  onAutosaveControl,
  onDraftLost,
}: PrRootBodyEditorProps) {
  const [body, setBody] = useState(initialBody);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
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
    setRecoveryModalOpen(true);
  }, [onDraftIdChange]);

  const handleLocalDelete = useCallback(() => {
    onDraftIdChange(null);
  }, [onDraftIdChange]);

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

  // Surface autosave controls (flush + badge) to the consumer.
  useEffect(() => {
    onAutosaveControl?.({ flush, badge });
  }, [onAutosaveControl, flush, badge]);

  // Surface the live body to the consumer.
  useEffect(() => {
    onBodyChange?.(body);
  }, [onBodyChange, body]);

  // Cross-tab ownership registration (Task 19 2-arg signature).
  useEffect(() => {
    if (draftId === null) return;
    return registerOpenComposer(draftId, ownerKey);
  }, [draftId, registerOpenComposer, ownerKey]);

  // Focus on mount.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleRecoveryRecreate = async () => {
    setRecoveryModalOpen(false);
    await flush();
  };

  const handleRecoveryDiscard = () => {
    setRecoveryModalOpen(false);
    onDraftLost?.();
  };

  const closedBanner = prState !== 'open';

  return (
    <div className={styles.editor}>
      {closedBanner && (
        <div className="composer-closed-banner muted" role="status">
          PR {prState === 'closed' ? 'closed' : 'merged'} — text not saved
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="composer-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="PR-level body"
        rows={4}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
      />

      <span
        className={`composer-badge composer-badge--${badge}`}
        role="status"
        data-testid="composer-badge"
      >
        {badge}
      </span>

      {createPortal(
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
        </Modal>,
        document.body,
      )}
    </div>
  );
}
