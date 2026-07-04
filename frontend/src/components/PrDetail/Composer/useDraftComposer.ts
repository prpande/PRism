import { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import type { ComposerAnchor, ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { postComment } from '../../../api/comment';
import { matchComposerKey } from './matchComposerKey';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import type { PrReference } from '../../../api/types';
import type React from 'react';

// #571 B1 fix — the resolve/unresolve control the reply composer hosts next to "Comment". The
// mutation lives in the parent (useThreadResolution); the composer owns only the "post the pending
// reply first, then resolve" orchestration and the GitHub-faithful label ("Comment and resolve
// conversation" when there is a postable draft).
export interface ThreadResolveControl {
  onResolve: () => void;
  isResolved: boolean;
  pending: boolean; // resolve mutation in flight (parent-owned)
  readOnly: boolean;
}

// The fully-derived render contract for that button — ComposerActionsBar stays presentational.
export interface ComposerResolveButton {
  label: string;
  busy: boolean; // aria-busy + spinner label
  disabled: boolean;
  isResolved: boolean; // green-outline (resolve) vs neutral (unresolve) styling
  onClick: () => void;
}

export interface UseDraftComposerParams {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey: ComposerOwnerKey;
  onClose: () => void;
  readOnly?: boolean;
  anchor: ComposerAnchor;
  deletePatchKind: 'deleteDraftComment' | 'deleteDraftReply';
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number, body: string) => void;
  onSaved?: () => void;
  flushRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
  // #571 B1 fix — when supplied (reply composers only), the actions bar renders a Resolve /
  // "Comment and resolve conversation" button wired to this control. Omitted for inline comments.
  resolveControl?: ThreadResolveControl;
}

export interface UseDraftComposerResult {
  editor: {
    body: string;
    setBody: (v: string) => void;
    previewMode: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    readOnly: boolean;
  };
  actions: {
    previewMode: boolean;
    onTogglePreview: () => void;
    badge: ComposerSaveBadge;
    saveDisabled: boolean;
    saveTooltip: string | undefined;
    addLabel: string;
    closedBanner: boolean;
    prState: 'open' | 'closed' | 'merged';
    postNowDisabled: boolean;
    postNowTooltip: string | undefined;
    posting: boolean;
    postError: string | null;
    readOnly: boolean;
    onDiscardClick: () => void;
    onSaveClick: () => void;
    onPostNow: () => void;
    // #571 B1 fix — present only when resolveControl was supplied; otherwise no button renders.
    resolve?: ComposerResolveButton;
  };
  modals: {
    discardModalOpen: boolean;
    onDiscardCancel: () => void;
    onDiscardConfirm: () => void;
    recoveryModalOpen: boolean;
    onRecoveryCancel: () => void;
    onRecoveryRecreate: () => void;
    onRecoveryDiscard: () => void;
  };
}

export function useDraftComposer(params: UseDraftComposerParams): UseDraftComposerResult {
  const {
    prRef,
    prState,
    initialBody = '',
    draftId,
    onDraftIdChange,
    registerOpenComposer,
    ownerKey,
    onClose,
    readOnly = false,
    anchor,
    deletePatchKind,
    anyOtherDraftsStaged = false,
    beginPosting,
    endPosting,
    onPosted,
    onSaved,
    flushRef,
    resolveControl,
  } = params;

  const [body, setBody] = useState(initialBody);
  const [previewMode, setPreviewMode] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
  // Declared here (not lower beside handlePostNow) so the Discard/Save handlers
  // below can read `posting` for their #601 in-flight guards without a
  // use-before-define.
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  // Mirrors recoveryModalOpen synchronously so Cmd+Enter's flush()→onClose()
  // sequence can detect a 404-recovery transition that opened mid-flush
  // (state updates aren't visible until the next render but the ref is).
  const recoveryModalOpenRef = useRef(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    anchor,
    onAssignedId: handleAssignedId,
    onDraftDeletedByServer: handleDraftDeletedByServer,
    onLocalDelete: handleLocalDelete,
    onSaved,
    disabled: readOnly,
  });

  // #299 — publish this composer's flush to the parent so a diff-line switch
  // can persist a pending debounced edit before swapping composers. Cleared on
  // unmount so a stale flush can't fire against a torn-down composer.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  }, [flush, flushRef]);

  // Keep the merge predicate truthy for as long as this composer is mounted
  // for a persisted draft. The refcount handles the rare case where two
  // composers (Files + Drafts tabs) open the same draft id simultaneously.
  useEffect(() => {
    if (draftId === null) return;
    return registerOpenComposer(draftId, ownerKey);
  }, [draftId, registerOpenComposer, ownerKey]);

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
    // #601 Defect C: an in-flight post owns this draft. Opening the discard modal
    // mid-post would let the user confirm a delete that races the post (orphaned
    // post, or delete-of-already-posted). This guard also covers the Escape
    // keyboard path (handleKeyDown → handleDiscardClick), which the button's
    // disabled attribute alone cannot.
    if (posting) return;
    if (draftId === null) {
      onClose();
      return;
    }
    setDiscardModalOpen(true);
  };

  const handleDiscardConfirm = async () => {
    // #601: defense-in-depth. handleDiscardClick already blocks the modal from
    // opening while posting, and the Modal focus-trap keeps a post from starting
    // while it's open — so this is unreachable today. The guard makes the
    // delete-must-not-race-the-post invariant explicit for any future caller.
    if (posting) {
      setDiscardModalOpen(false);
      return;
    }
    if (draftId !== null) {
      const result = await sendPatch(prRef, { kind: deletePatchKind, payload: { id: draftId } });
      if (!result.ok) return; // network/4xx → stay in modal (sendPatch never throws)
      onDraftIdChange(null);
    }
    setDiscardModalOpen(false);
    onClose();
  };

  const handleSaveClick = async () => {
    // #601 Defect C (Save sibling): saving mid-post fires an update PUT against
    // the same draft the post is shipping. Inert during a post, matching Discard.
    if (saveDisabled || posting) return;
    await flush();
  };

  // Post-now derived values — computed before handlePostNow so the handler
  // can close over them without a temporal dead zone issue.
  const postNowDisabled = saveDisabled || posting || anyOtherDraftsStaged;
  const postNowTooltip = anyOtherDraftsStaged
    ? 'You have a review in progress — submit or discard it to post a single comment.'
    : saveTooltip;

  // Shared post pipeline for "Comment" and "Comment and resolve": flush the draft, POST it, and
  // report whether the comment actually posted. Returns false on a 404-recovery transition, an
  // unsaved draft, or a POST failure (the caller then leaves the composer OPEN with its error).
  // It does NOT close the composer — the caller owns that, so "Comment and resolve" can sequence
  // the resolve between the post and the close.
  const postDraft = async (): Promise<boolean> => {
    setPostError(null);
    setPosting(true);
    beginPosting?.(); // synchronous, BEFORE flush (no flicker)
    try {
      // #601 Defect A: flush()'s return is authoritative — do NOT fall back to the
      // stale `draftId` prop. On a 404 mid-flush, useComposerAutoSave clears its
      // draftId, fires onDraftDeletedByServer (which sets recoveryModalOpenRef and
      // opens the recovery modal), and flush() returns null. The old `?? draftId`
      // fallback used the not-yet-recleared prop and posted against the deleted
      // draft → a doomed POST plus an inline error stacked behind the recovery
      // modal. Short-circuit on that transition, exactly as handleKeyDown does.
      const id = await flush();
      if (recoveryModalOpenRef.current) return false;
      if (!id) {
        setPostError('Could not save the draft. Try again.');
        return false;
      }
      const res = await postComment(prRef, id);
      if (res.ok) {
        onPosted?.(res.postedCommentId, body);
        return true;
      }
      setPostError(res.message);
      return false;
    } finally {
      // Balanced 1:1 with beginPosting; setPosting after a later unmount is a React-18 no-op.
      setPosting(false);
      endPosting?.();
    }
  };

  const handlePostNow = async () => {
    if (postNowDisabled) return;
    if (await postDraft()) onClose();
  };

  // #571 B1 fix — the composer's Resolve button. GitHub relabels its resolve button to "Comment
  // and resolve conversation" the moment the reply box has text and, on click, POSTS the reply
  // then resolves. Our earlier build shipped a resolve-only button next to "Comment", so typing a
  // reply and clicking Resolve resolved the thread and DROPPED the comment (it never posted, and
  // the resolved thread then collapsed, hiding the composer). Here: post first, resolve only if the
  // post succeeded; a failed post keeps the composer open and does NOT resolve.
  const handleResolveClick = async () => {
    if (!resolveControl || resolveControl.pending || posting || resolveControl.readOnly) return;
    if (resolveControl.isResolved || postNowDisabled) {
      // Unresolve, or nothing postable in the composer → resolve/unresolve only.
      resolveControl.onResolve();
      return;
    }
    if (await postDraft()) {
      resolveControl.onResolve();
      onClose();
    }
  };

  // `postNowDisabled` folds in bodyEmpty / below-threshold / other-drafts-staged / readOnly — so
  // "postable" is exactly `!postNowDisabled`. Only then is the combined "Comment and resolve"
  // offered; otherwise the button is a plain Resolve/Unresolve.
  const canCommentAndResolve = !!resolveControl && !resolveControl.isResolved && !postNowDisabled;
  const resolveBusy = !!resolveControl && (posting || resolveControl.pending);
  const resolve: ComposerResolveButton | undefined = resolveControl
    ? {
        isResolved: resolveControl.isResolved,
        busy: resolveBusy,
        disabled: resolveBusy || resolveControl.readOnly,
        label: resolveBusy
          ? resolveControl.isResolved
            ? 'Unresolving…'
            : 'Resolving…'
          : resolveControl.isResolved
            ? 'Unresolve conversation'
            : canCommentAndResolve
              ? 'Comment and resolve conversation'
              : 'Resolve conversation',
        onClick: handleResolveClick,
      }
    : undefined;

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
    const shortcut = matchComposerKey(e);
    if (shortcut === null) return;
    e.preventDefault();
    if (shortcut === 'toggle-preview') {
      setPreviewMode((p) => !p);
    } else if (shortcut === 'submit') {
      // #601 Defect C: Cmd/Ctrl+Enter is the keyboard sibling of Save — flush()
      // + onClose(). Inert during a post so it can't fire an update PUT racing
      // the post or unmount the composer mid-post. (Escape's path is guarded
      // inside handleDiscardClick.)
      if (posting) return;
      void (async () => {
        await flush();
        if (recoveryModalOpenRef.current) return; // 404-recovery opened mid-flush → keep modal
        onClose();
      })();
    } else if (shortcut === 'escape') {
      handleDiscardClick();
    }
  };

  const closedBanner = prState !== 'open';

  // Post-now footer logic (#302 Task 9)
  const addLabel = anyOtherDraftsStaged ? 'Add review comment' : 'Add to review';

  // Auto-focus the textarea on mount so the user can start typing
  // immediately after clicking a diff line.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return {
    editor: { body, setBody, previewMode, textareaRef, handleKeyDown, readOnly },
    actions: {
      previewMode,
      onTogglePreview: () => setPreviewMode((p) => !p),
      badge,
      saveDisabled,
      saveTooltip,
      addLabel,
      closedBanner,
      prState,
      postNowDisabled,
      postNowTooltip,
      posting,
      postError,
      readOnly,
      onDiscardClick: handleDiscardClick,
      onSaveClick: handleSaveClick,
      onPostNow: handlePostNow,
      resolve,
    },
    modals: {
      discardModalOpen,
      onDiscardCancel: () => setDiscardModalOpen(false),
      onDiscardConfirm: handleDiscardConfirm,
      recoveryModalOpen,
      onRecoveryCancel: () => {
        // #601: reset the ref alongside the state, matching recreate/discard.
        // handlePostNow + handleKeyDown's submit short-circuit on this ref, so a
        // stale-true value after dismissal would silently break Post/Cmd+Enter
        // for the rest of the session. (Today the inline recovery Modal sets
        // disableEscDismiss with no cancel affordance, so this path is
        // unreachable — but the invariant must hold for all three exits.)
        recoveryModalOpenRef.current = false;
        setRecoveryModalOpen(false);
      },
      onRecoveryRecreate: handleRecoveryRecreate,
      onRecoveryDiscard: handleRecoveryDiscard,
    },
  };
}
