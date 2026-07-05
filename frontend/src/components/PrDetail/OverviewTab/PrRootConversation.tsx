import type { DraftCommentDto, DraftReplyDto, PrReference } from '../../../api/types';
import { CollapsedComposerAffordance } from '../Composer/CollapsedComposerAffordance';
import { PrRootReplyComposer } from '../Composer/PrRootReplyComposer';
import { MarkAllReadButton } from './MarkAllReadButton';
import styles from './PrRootConversation.module.css';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import { useDraftBackedDisclosure } from '../../../hooks/useDraftBackedDisclosure';

export interface PrRootConversationReplyContext {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  // Pre-existing PR-root draft (filePath/lineNumber/anchoredSha all null per
  // spec § 5.6) hydrates the composer with its body when the user opens the
  // reply panel. Mirrors the inline-composer hydration path.
  existingPrRootDraft: DraftCommentDto | null;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  onComposerClose: () => void;
  // #744 — optimistic insert seam, forwarded to PrRootReplyComposer so a
  // PR-root create appears in the Drafts tab without waiting for a refetch.
  insertDraftLocally: (draft: DraftCommentDto | DraftReplyDto) => void;
  // Spec § 5.7a. Forwarded to PrRootReplyComposer.
  readOnly?: boolean;
}

// #620 — the PR-root composer (Reply affordance + Mark-all-read), lifted out of the retired
// PrRootConversation comment-list wrapper. ActivityFeed now renders the PR-root comments
// themselves (merged into the unified timeline); OverviewTab passes this component as
// ActivityFeed's `composerSlot` so the composer still lives visually with the conversation.
export function PrRootConversationActions({
  replyContext,
  onPosted,
}: {
  replyContext: PrRootConversationReplyContext;
  // Fires after the composer's own POST succeeds (same-tab, immediate feedback). The caller
  // bridges this into ActivityFeed's refetchNewest so the just-posted comment appears without
  // waiting on the SSE/poll backstop (refetchNewest dedups by id, so a later SSE-driven refetch
  // doesn't duplicate it).
  onPosted?: () => void;
}) {
  const {
    prRef,
    prState,
    existingPrRootDraft,
    registerOpenComposer,
    onComposerClose,
    insertDraftLocally,
    readOnly,
  } = replyContext;
  // The composer auto-opens when a saved PR-root draft exists, including a
  // cross-tab arrival after mount (OverviewTab hydrates existingPrRootDraft from
  // the shared draft session). See useDraftBackedDisclosure for the resync rationale.
  const {
    composerOpen,
    draftId,
    setDraftId,
    open: handleReplyClick,
    close: closeComposer,
  } = useDraftBackedDisclosure(existingPrRootDraft);

  const handleClose = () => {
    closeComposer();
    onComposerClose();
  };

  return (
    <div className={styles.prRootConversationActions}>
      <div className={styles.prRootConversationActionsRow}>
        {!composerOpen && (
          <CollapsedComposerAffordance
            label={existingPrRootDraft ? 'Continue draft…' : 'Reply…'}
            ariaLabel="Reply to the PR conversation"
            hasDraft={!!existingPrRootDraft}
            readOnly={readOnly ?? false}
            onOpen={handleReplyClick}
          />
        )}
        <MarkAllReadButton prRef={prRef} readOnly={readOnly ?? false} />
      </div>
      {composerOpen && (
        <PrRootReplyComposer
          prRef={prRef}
          prState={prState}
          initialBody={existingPrRootDraft?.bodyMarkdown ?? ''}
          draftId={draftId}
          onDraftIdChange={setDraftId}
          registerOpenComposer={registerOpenComposer}
          onClose={handleClose}
          onPosted={onPosted}
          onCreated={insertDraftLocally}
          readOnly={readOnly ?? false}
        />
      )}
    </div>
  );
}
