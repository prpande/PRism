import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './PrRootBodyEditor.module.css';
import { useComposerAutoSave, type ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';
import { ComposerStatusBadge } from './ComposerStatusBadge';
import { Modal } from '../../Modal/Modal';
import type { DraftCommentDto, DraftReplyDto, PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';

export interface PrRootBodyEditorProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  // Consumed only on first mount. If the draft identity can change while this
  // editor stays mounted, the consumer MUST supply a `key` prop (e.g.
  // key={draftId ?? 'new'}) to force a clean remount; otherwise the body will
  // be stale.
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
  // Default true. The Overview reply composer (PrRootReplyComposer) renders its
  // OWN footer badge for diff-composer parity and passes false here to avoid a
  // duplicate badge inside the frame. SubmitDialog keeps the default.
  showBadge?: boolean;
  // Surfaces the live body to the consumer so it can drive Post / preview.
  // Read from a ref and invoked on `body` changes only, NOT on callback-identity
  // change — consumers may pass inline callbacks safely.
  onBodyChange?: (body: string) => void;
  // Surfaces the autosave controls so the consumer can flush before Post and
  // mirror the badge into its own action bar.
  // Read from a ref and invoked on flush/badge changes only, NOT on
  // callback-identity change — consumers may pass inline callbacks safely.
  onAutosaveControl?: (control: {
    flush: () => Promise<string | null>;
    badge: ComposerSaveBadge;
    setValue: (next: string) => void; // #586 — the editor's own setBody
  }) => void;
  // Fired when the user discards from the 404-recovery modal. The consumer
  // decides what to do (composer closes; SubmitDialog clears its editor).
  onDraftLost?: () => void;
  // #744 — forwarded to useComposerAutoSave so a PR-root create optimistically
  // inserts the new draft into the shared session. This surface reaches
  // useComposerAutoSave directly (not via useDraftComposer), which is why the
  // insert seam lives in that hook rather than in the wrapper.
  onCreated?: (draft: DraftCommentDto | DraftReplyDto) => void;
  // #586 — optional external textarea ref, attached via a merged callback-ref
  // alongside the internal ref. Supplied by PrRootReplyComposer so its toolbar
  // can act on this textarea; omitted by SubmitDialog (no toolbar there).
  textAreaRef?: React.RefObject<HTMLTextAreaElement | null>;
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
  showBadge = true,
  onBodyChange,
  onAutosaveControl,
  onDraftLost,
  onCreated,
  textAreaRef,
}: PrRootBodyEditorProps) {
  const [body, setBody] = useState(initialBody);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Merged callback-ref: the internal ref (mount-focus effect below) and the
  // optional external textAreaRef (toolbar consumer) both see the same node.
  const setTextAreaRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textareaRef.current = el;
      if (textAreaRef) textAreaRef.current = el;
    },
    [textAreaRef],
  );

  // Read the surfaced callbacks from refs so an unstable (inline) consumer
  // callback identity does NOT churn the surfacing effects below. The effects
  // fire on flush/badge/body changes only — never on callback-identity change.
  const onAutosaveControlRef = useRef(onAutosaveControl);
  useEffect(() => {
    onAutosaveControlRef.current = onAutosaveControl;
  });
  const onBodyChangeRef = useRef(onBodyChange);
  useEffect(() => {
    onBodyChangeRef.current = onBodyChange;
  });

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
    onCreated,
    disabled: readOnly,
  });

  // Surface autosave controls (flush + badge + setValue) to the consumer.
  // `setBody` is a useState setter with stable identity — it doesn't need to
  // be in the deps and doesn't change this effect's fire cadence.
  useEffect(() => {
    onAutosaveControlRef.current?.({ flush, badge, setValue: setBody });
  }, [flush, badge]);

  // Surface the live body to the consumer.
  useEffect(() => {
    onBodyChangeRef.current?.(body);
  }, [body]);

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

  return (
    <div className={styles.editor}>
      <textarea
        ref={setTextAreaRef}
        className="composer-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="PR-level body"
        rows={4}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
      />

      {showBadge && <ComposerStatusBadge badge={badge} readOnly={readOnly} />}

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
