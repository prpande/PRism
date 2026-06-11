import type { DraftCommentDto, IssueCommentDto, PrReference } from '../../../api/types';
import { CommentCard } from '../Comment/CommentCard';
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
  // Spec § 5.7a. Forwarded to PrRootReplyComposer.
  readOnly?: boolean;
}

interface PrRootConversationProps {
  comments: IssueCommentDto[];
  // When omitted, the conversation renders read-only (no Reply button, no
  // Mark-all-read, the legacy S3 footer copy is shown). OverviewTab provides
  // it once S4 PR5 is wired up.
  replyContext?: PrRootConversationReplyContext;
}

export function PrRootConversation({ comments, replyContext }: PrRootConversationProps) {
  return (
    <section className={`overview-card ${styles.prRootConversation}`}>
      {comments.length > 0 && (
        <ol className={styles.timeline} aria-label="PR comments">
          {comments.map((comment) => (
            <li key={comment.id} className={styles.item}>
              <span className={styles.rail} aria-hidden="true">
                <span className={styles.node} />
              </span>
              <CommentCard
                author={comment.author}
                avatarUrl={comment.avatarUrl}
                createdAt={comment.createdAt}
                body={comment.body}
                density="comfortable"
                data-testid="pr-root-comment"
                aria-label={`Comment by ${comment.author}`}
              />
            </li>
          ))}
        </ol>
      )}

      {replyContext ? (
        <PrRootConversationActions replyContext={replyContext} />
      ) : (
        // Rendered when the conversation is mounted in a read-only context
        // (e.g., a future Drafts-tab preview slot).
        <p className={`${styles.prRootConversationFooter} muted`}>
          Composer not available in this context.
        </p>
      )}
    </section>
  );
}

function PrRootConversationActions({
  replyContext,
}: {
  replyContext: PrRootConversationReplyContext;
}) {
  const { prRef, prState, existingPrRootDraft, registerOpenComposer, onComposerClose, readOnly } =
    replyContext;
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
          readOnly={readOnly ?? false}
        />
      )}
    </div>
  );
}
