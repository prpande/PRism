import { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import type { ComposerAnchor, ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { postComment } from '../../../api/comment';
import { matchComposerKey } from './matchComposerKey';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import type { PrReference } from '../../../api/types';
import type React from 'react';

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
  } = params;

  const [body, setBody] = useState(initialBody);
  const [previewMode, setPreviewMode] = useState(false);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);

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
    if (draftId === null) {
      onClose();
      return;
    }
    setDiscardModalOpen(true);
  };

  const handleDiscardConfirm = async () => {
    if (draftId !== null) {
      const result = await sendPatch(prRef, { kind: deletePatchKind, payload: { id: draftId } });
      if (!result.ok) return; // network/4xx → stay in modal (sendPatch never throws)
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

  // Post-now derived values — computed before handlePostNow so the handler
  // can close over them without a temporal dead zone issue.
  const postNowDisabled = saveDisabled || posting || anyOtherDraftsStaged;
  const postNowTooltip = anyOtherDraftsStaged
    ? 'You have a review in progress — submit or discard it to post a single comment.'
    : saveTooltip;

  const handlePostNow = async () => {
    if (postNowDisabled) return;
    setPostError(null);
    setPosting(true);
    beginPosting?.(); // synchronous, BEFORE flush (no flicker)
    try {
      const id = (await flush()) ?? draftId; // id assigned during flush; prop is stale
      if (!id) {
        setPostError('Could not save the draft. Try again.');
        return;
      }
      const res = await postComment(prRef, id);
      if (res.ok) {
        onPosted?.(res.postedCommentId, body);
        onClose();
      } else {
        setPostError(res.message);
      }
    } finally {
      // Safe even when onClose() above triggers unmount: endPosting is an
      // idempotent ref-counter decrement (balanced 1:1 with beginPosting),
      // and setPosting after unmount is a React-18 no-op.
      setPosting(false);
      endPosting?.();
    }
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
    const shortcut = matchComposerKey(e);
    if (shortcut === null) return;
    e.preventDefault();
    if (shortcut === 'toggle-preview') {
      setPreviewMode((p) => !p);
    } else if (shortcut === 'submit') {
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
      badge, saveDisabled, saveTooltip, addLabel, closedBanner, prState,
      postNowDisabled, postNowTooltip, posting, postError, readOnly,
      onDiscardClick: handleDiscardClick,
      onSaveClick: handleSaveClick,
      onPostNow: handlePostNow,
    },
    modals: {
      discardModalOpen,
      onDiscardCancel: () => setDiscardModalOpen(false),
      onDiscardConfirm: handleDiscardConfirm,
      recoveryModalOpen,
      onRecoveryCancel: () => setRecoveryModalOpen(false),
      onRecoveryRecreate: handleRecoveryRecreate,
      onRecoveryDiscard: handleRecoveryDiscard,
    },
  };
}
