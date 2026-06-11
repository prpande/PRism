import type {
  DraftCommentDto,
  DraftReplyDto,
  PrReference,
  ReviewThreadDto,
} from '../../../../api/types';
import { CommentCard } from '../../Comment/CommentCard';
import { CollapsedComposerAffordance } from '../../Composer/CollapsedComposerAffordance';
import { ReplyComposer } from '../../Composer/ReplyComposer';
import styles from './ExistingCommentWidget.module.css';
import {
  computeAnyOtherDraftsStaged,
  type ComposerOwnerKey,
} from '../../../../hooks/useDraftSession';
import { useDraftBackedDisclosure } from '../../../../hooks/useDraftBackedDisclosure';
import type { OptimisticComment } from '../optimisticComment';

export interface ExistingCommentWidgetReplyContext {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  draftReplies: DraftReplyDto[];
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  // Called after the reply composer closes so the parent can refetch the
  // session (mirrors the on-close path the inline composer uses for the
  // own-tab refresh-after-write case).
  onReplyComposerClose: () => void;
  // Spec § 5.7a. Forwarded to ReplyComposer; disables textarea + save.
  readOnly?: boolean;
  // #302 — post-now wiring (Task 11a). The staged-check needs this reply's own
  // draft id, which only exists here (inside ThreadView). So the parent hands
  // down the raw pieces and ThreadView calls computeAnyOtherDraftsStaged with
  // its draftReplyId. All optional so pure-rendering tests can omit them.
  draftComments?: DraftCommentDto[];
  postingInProgress?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  // Fired after a successful post-now so the parent refetches the session and
  // the just-posted comment surfaces. 11b passes the posted body so the parent
  // can stash an optimistic placeholder for this thread.
  onReplyPosted?: (threadId: string, postedCommentId: number, body: string) => void;
  // #302 Task 11b — optimistic reply placeholders, keyed by threadId. Each
  // thread renders its entries (dimmed) AFTER its real comments, filtered to
  // exclude any whose postedCommentId already matches a real comment's
  // databaseId (de-dup by databaseId — see optimisticComment.ts). Optional so
  // pure-rendering tests can omit it.
  optimisticByThread?: Record<string, OptimisticComment[]>;
}

export interface ExistingCommentWidgetProps {
  threads: ReviewThreadDto[];
  // When omitted, the widget renders read-only (no Reply button, no composer).
  // Tests of pure thread rendering omit this; FilesTab provides it.
  replyContext?: ExistingCommentWidgetReplyContext;
}

export function ExistingCommentWidget({ threads, replyContext }: ExistingCommentWidgetProps) {
  if (threads.length === 0) return null;

  return (
    <div className={`comment-widget ${styles.commentWidget}`} data-testid="comment-widget">
      {threads.map((thread) => (
        <ThreadView key={thread.threadId} thread={thread} replyContext={replyContext} />
      ))}
    </div>
  );
}

function ThreadView({
  thread,
  replyContext,
}: {
  thread: ReviewThreadDto;
  replyContext: ExistingCommentWidgetReplyContext | undefined;
}) {
  // Hydrate from any existing draft reply against this thread. A user who
  // returns to the page mid-flow sees a "Reply (saved draft)" affordance
  // and the composer pre-populated with the persisted body when opened.
  const existingDraft = replyContext?.draftReplies.find(
    (r) => r.parentThreadId === thread.threadId,
  );

  // The composer auto-mounts when there is already a saved draft for this
  // thread (incl. cross-tab arrivals after mount); otherwise the user opens it
  // via the Reply button. See useDraftBackedDisclosure for the resync rationale.
  const {
    composerOpen,
    draftId: draftReplyId,
    setDraftId: setDraftReplyId,
    open: handleReplyClick,
    close: closeComposer,
  } = useDraftBackedDisclosure(existingDraft);

  const handleComposerClose = () => {
    closeComposer();
    replyContext?.onReplyComposerClose();
  };

  // #302 Task 11b — optimistic placeholders for this thread, filtered to drop
  // any whose postedCommentId already appears as a real comment's databaseId
  // (belt-and-suspenders with FilesTab's cleanup effect; the de-dup key is
  // databaseId, never body text).
  const optimisticForThread = (replyContext?.optimisticByThread?.[thread.threadId] ?? []).filter(
    (o) => !thread.comments.some((c) => c.databaseId != null && c.databaseId === o.postedCommentId),
  );

  return (
    <div
      className={`comment-thread${thread.isResolved ? ' comment-thread--resolved' : ''} ${styles.commentThread}${thread.isResolved ? ` ${styles.commentThreadResolved}` : ''}`}
      data-thread-id={thread.threadId}
    >
      {thread.comments.map((comment, i) => (
        <CommentCard
          key={comment.commentId}
          author={comment.author}
          avatarUrl={comment.avatarUrl}
          createdAt={comment.createdAt}
          body={comment.body}
          density="compact"
          data-testid="inline-comment-card"
          bandEnd={
            thread.isResolved && i === 0 ? (
              <span aria-label="Resolved thread">Resolved</span>
            ) : undefined
          }
        />
      ))}

      {optimisticForThread.map((o) => (
        <CommentCard
          key={o.clientId}
          author={o.author}
          createdAt={o.createdAt}
          body={o.body}
          density="compact"
          className="comment-card--posting"
          data-testid="inline-comment-card-optimistic"
        />
      ))}

      {replyContext && !composerOpen && (
        <div className={`comment-thread-actions ${styles.commentThreadActions}`}>
          <CollapsedComposerAffordance
            label={existingDraft ? 'Continue draft…' : 'Reply…'}
            ariaLabel={`Reply to thread on ${thread.filePath} line ${thread.lineNumber}`}
            hasDraft={!!existingDraft}
            readOnly={replyContext.readOnly}
            onOpen={handleReplyClick}
          />
        </div>
      )}

      {replyContext && composerOpen && (
        <ReplyComposer
          prRef={replyContext.prRef}
          prState={replyContext.prState}
          parentThreadId={thread.threadId}
          initialBody={existingDraft?.bodyMarkdown ?? ''}
          draftId={draftReplyId}
          onDraftIdChange={setDraftReplyId}
          registerOpenComposer={replyContext.registerOpenComposer}
          onClose={handleComposerClose}
          readOnly={replyContext.readOnly ?? false}
          anyOtherDraftsStaged={computeAnyOtherDraftsStaged(
            replyContext.draftComments ?? [],
            replyContext.draftReplies,
            draftReplyId,
            replyContext.postingInProgress ?? false,
          )}
          beginPosting={replyContext.beginPosting}
          endPosting={replyContext.endPosting}
          onPosted={(id, postedBody) =>
            replyContext.onReplyPosted?.(thread.threadId, id, postedBody)
          }
        />
      )}
    </div>
  );
}
