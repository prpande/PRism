import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import styles from './PrRootReplyComposer.module.css';
import {
  COMPOSER_CREATE_THRESHOLD,
  type ComposerSaveBadge,
} from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { postRootComment, type PostRootCommentError } from '../../../api/rootComment';
import { Modal } from '../../Modal/Modal';
import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import { ComposerStatusBadge } from './ComposerStatusBadge';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import { PrRootBodyEditor } from './PrRootBodyEditor';
import { FormattingToolbar } from './FormattingToolbar';
import type { FormattingHandle } from './formattingHandle';
import type { DraftCommentDto, DraftReplyDto, PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import { matchComposerKey } from './matchComposerKey';

type AutosaveControl = {
  flush: () => Promise<string | null>;
  badge: ComposerSaveBadge;
  setValue: (next: string) => void; // #586
};

export interface PrRootReplyComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody?: string;
  // Controlled draftId. Parent (Overview tab) tracks this so it can hydrate
  // from `useDraftSession.draftComments` (anchor-less: filePath/lineNumber/
  // anchoredSha all null per spec § 5.6).
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  onClose: () => void;
  // #620 — fires on a successful post, alongside onClose. Distinct from onClose because onClose
  // also fires on discard/cancel; the caller (OverviewTab) bridges this into ActivityFeed's
  // refetchNewest, so a discard must not trigger a spurious refetch.
  onPosted?: () => void;
  // #744 — forwarded to the wrapped PrRootBodyEditor so a PR-root create
  // optimistically inserts the new draft into the shared session.
  onCreated?: (draft: DraftCommentDto | DraftReplyDto) => void;
  // Spec § 5.7a. Set when a peer tab claimed cross-tab ownership of this
  // PR. Disables the action buttons; the wrapped editor short-circuits
  // autosave via its own `readOnly` gate.
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
  onPosted,
  onCreated,
  readOnly = false,
}: PrRootReplyComposerProps) {
  // Live body tracked from the wrapped editor (spec § 4.7 — drives Post gating
  // and Preview). The editor owns the textarea + autosave; the composer keeps
  // only the action affordances.
  const [body, setBody] = useState(initialBody);
  const [badge, setBadge] = useState<ComposerSaveBadge>('saved');
  const [previewMode, setPreviewMode] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [postInFlight, setPostInFlight] = useState(false);
  const [discardInFlight, setDiscardInFlight] = useState(false);
  const [postError, setPostError] = useState<PostRootCommentError | null>(null);

  // Captured from PrRootBodyEditor.onAutosaveControl so handlePost can flush the
  // debounce before shipping.
  const autosaveControl = useRef<AutosaveControl | null>(null);

  const handleAutosaveControl = useCallback((control: AutosaveControl) => {
    autosaveControl.current = control;
    setBadge(control.badge);
  }, []);

  const handleBodyChange = useCallback((next: string) => {
    setBody(next);
    // Spec § 4.7: any keystroke clears the post error.
    setPostError(null);
  }, []);

  // #586 — shared with PrRootBodyEditor (via textAreaRef) and the formatting
  // toolbar handle below.
  const bodyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Drives the editor's OWN setBody (surfaced as autosaveControl.setValue) —
  // NOT handleBodyChange (the parent mirror). The editor is uncontrolled from
  // the parent: it re-applies its stale internal `body` state as `value` on
  // every render, so writing only the parent mirror would be silently
  // discarded by React's controlled-input reconciliation. The editor's
  // existing onBodyChange effect propagates the new value back to
  // handleBodyChange, keeping the mirror in sync without a second write path.
  const applyExternalValue = useCallback((next: string) => {
    autosaveControl.current?.setValue(next);
  }, []);

  const formattingHandle: FormattingHandle = {
    textareaRef: bodyTextAreaRef,
    value: body,
    onChange: applyExternalValue,
    previewMode,
    onTogglePreview: () => setPreviewMode((p) => !p),
    disabled: readOnly || postInFlight,
  };

  const handleDraftLost = useCallback(() => {
    onClose();
  }, [onClose]);

  const trimmedLength = body.trim().length;
  const bodyEmpty = trimmedLength === 0;
  const belowCreateThreshold = draftId === null && trimmedLength < COMPOSER_CREATE_THRESHOLD;
  const inFlight = postInFlight || discardInFlight;
  const postDisabled = bodyEmpty || belowCreateThreshold || readOnly || inFlight;
  const postTooltip = readOnly
    ? 'Another tab is editing this PR.'
    : bodyEmpty
      ? 'Type something to post.'
      : belowCreateThreshold
        ? `Type at least ${COMPOSER_CREATE_THRESHOLD} characters to post.`
        : undefined;

  const handleDiscardClick = () => {
    if (postInFlight) return; // Closing mid-post would orphan the response handler.
    if (draftId === null) {
      onClose();
      return;
    }
    setDiscardModalOpen(true);
  };

  const handleDiscardConfirm = async () => {
    if (draftId === null) {
      setDiscardModalOpen(false);
      onClose();
      return;
    }
    setDiscardInFlight(true);
    try {
      const result = await sendPatch(prRef, {
        kind: 'deleteDraftComment',
        payload: { id: draftId },
      });
      if (!result.ok) return;
      onDraftIdChange(null);
      setDiscardModalOpen(false);
      onClose();
    } finally {
      setDiscardInFlight(false);
    }
  };

  const handlePost = async () => {
    if (postDisabled || !autosaveControl.current) return;
    setPostError(null);
    setPostInFlight(true);
    try {
      // Drain the debounce so the server has the latest body before posting.
      await autosaveControl.current.flush();
      const result = await postRootComment(prRef);
      if (!result.ok) {
        setPostError(result);
        return;
      }
      // Success: the SSE refetch (Task 14) reflects the posted comment + draft
      // removal. onPosted fires first so the caller's immediate feed-refetch
      // bridge (#620) races against, rather than waits on, that SSE path.
      onPosted?.();
      onClose();
    } finally {
      setPostInFlight(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const shortcut = matchComposerKey(e);
    if (shortcut === null) return;
    e.preventDefault();
    if (shortcut === 'toggle-preview') {
      setPreviewMode((p) => !p);
    } else if (shortcut === 'submit') {
      if (!postDisabled) void handlePost();
    } else if (shortcut === 'escape') {
      handleDiscardClick();
    }
  };

  return (
    <div
      role="form"
      aria-label="Reply to this PR"
      data-composer="true"
      className={`composer-frame ${styles.prRootReplyComposer}`}
      onKeyDown={handleKeyDown}
    >
      <FormattingToolbar handle={formattingHandle} />
      {/* Keep the editor mounted across Preview toggles so autosave continuity
          and the mount-once initialBody contract hold. Hide (not unmount) it
          while previewing. */}
      <div hidden={previewMode}>
        {/* No `key={draftId}`: within one open session draftId transitions
            null→uuid on the first autosave-create, and keying on it would
            remount the editor and reset its body to initialBody (the editor's
            mount-once contract), discarding the user's in-progress text. The
            composer mounts fresh each time the parent opens it, so the editor's
            initialBody is correct on every open without a key. */}
        <PrRootBodyEditor
          prRef={prRef}
          prState={prState}
          initialBody={initialBody}
          draftId={draftId}
          onDraftIdChange={onDraftIdChange}
          registerOpenComposer={registerOpenComposer}
          ownerKey="reply-composer"
          // Folds `postInFlight` into the editor's readOnly, so the root
          // composer's autosave IS disabled during a post — the opposite of the
          // inline/reply composers (#644), which keep `posting` off the hook's
          // `disabled` to preserve #601 Fix A's mid-flush 404 detection. The
          // asymmetry is intentional: the root post path does NOT rely on that
          // flush-404 (it's why #601 Defect B was descoped — the root composer
          // posts once with no double-surface), so suppressing autosave here is
          // safe, not a fragile timing reliance.
          readOnly={readOnly || postInFlight}
          showBadge={false}
          onBodyChange={handleBodyChange}
          onAutosaveControl={handleAutosaveControl}
          onDraftLost={handleDraftLost}
          onCreated={onCreated}
          textAreaRef={bodyTextAreaRef}
        />
      </div>

      {previewMode && <ComposerMarkdownPreview body={body} />}

      {postError && (
        <div role="alert" data-testid="post-error" className={styles.postError}>
          {postError.code === 'already-posted-body-mismatch' ? (
            <span data-testid="post-error-already-posted">
              This comment was already posted. Your edits since then haven't been shipped.
              {postError.postedCommentId != null && (
                <> (comment #{postError.postedCommentId})</>
              )}{' '}
              Discard your local edits and reload to continue.
            </span>
          ) : (
            <>
              Couldn't post to GitHub: {postError.message}.{' '}
              <button type="button" onClick={handlePost} disabled={postDisabled}>
                Retry
              </button>
            </>
          )}
        </div>
      )}

      <div className="composer-actions">
        {/* left group */}
        <AiComposerAssistant />

        <ComposerStatusBadge badge={badge} readOnly={readOnly} />

        <span className="composer-actions-spacer" aria-hidden="true" />

        {/* right group */}
        <button
          type="button"
          className="composer-discard"
          onClick={handleDiscardClick}
          disabled={readOnly || inFlight}
          aria-disabled={readOnly || inFlight || undefined}
        >
          Discard
        </button>

        <button
          type="button"
          className="composer-post"
          aria-disabled={postDisabled}
          title={postTooltip}
          onClick={handlePost}
          disabled={postDisabled}
        >
          {postInFlight ? 'Posting…' : 'Post'}
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
    </div>
  );
}
