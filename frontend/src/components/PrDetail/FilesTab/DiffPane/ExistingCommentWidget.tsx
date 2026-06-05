import { useEffect, useState } from 'react';
import type { DraftReplyDto, PrReference, ReviewThreadDto } from '../../../../api/types';
import { Avatar } from '../../../Avatar/Avatar';
import { MarkdownRenderer } from '../../../Markdown/MarkdownRenderer';
import { ReplyComposer } from '../../Composer/ReplyComposer';
import styles from './ExistingCommentWidget.module.css';
import type { ComposerOwnerKey } from '../../../../hooks/useDraftSession';

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
  // thread; otherwise the user opens it via the Reply button. The useEffect
  // below re-syncs when `replyContext.draftReplies` changes after mount —
  // e.g., another tab creates a draft reply and `useStateChangedSubscriber`
  // refetches the session. Without it, the useState initializer would be
  // frozen at the first-render value and the auto-open silently misses
  // cross-tab arrivals.
  const [composerOpen, setComposerOpen] = useState<boolean>(!!existingDraft);
  const [draftReplyId, setDraftReplyId] = useState<string | null>(existingDraft?.id ?? null);

  useEffect(() => {
    if (!existingDraft) return;
    setDraftReplyId(existingDraft.id);
    setComposerOpen(true);
  }, [existingDraft?.id]);

  const handleReplyClick = () => setComposerOpen(true);

  const handleComposerClose = () => {
    setComposerOpen(false);
    replyContext?.onReplyComposerClose();
  };

  return (
    <div
      className={`comment-thread${thread.isResolved ? ' comment-thread--resolved' : ''} ${styles.commentThread}${thread.isResolved ? ` ${styles.commentThreadResolved}` : ''}`}
      data-thread-id={thread.threadId}
    >
      {thread.comments.map((comment) => (
        <div key={comment.commentId} className={`comment-entry ${styles.commentEntry}`}>
          <div className={`comment-meta ${styles.commentMeta}`}>
            <Avatar src={comment.avatarUrl} login={comment.author} size="sm" />
            <span className={`comment-author ${styles.commentAuthor}`}>{comment.author}</span>
            <time className={`comment-time ${styles.commentTime}`} dateTime={comment.createdAt}>
              {new Date(comment.createdAt).toLocaleDateString()}
            </time>
          </div>
          <div className={`comment-body ${styles.commentBody}`}>
            <MarkdownRenderer source={comment.body} />
          </div>
        </div>
      ))}

      {replyContext && !composerOpen && (
        <div className={`comment-thread-actions ${styles.commentThreadActions}`}>
          <button
            type="button"
            className="comment-thread-reply btn btn-ghost btn-sm"
            aria-label={`Reply to thread on ${thread.filePath} line ${thread.lineNumber}`}
            onClick={handleReplyClick}
          >
            Reply
          </button>
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
        />
      )}
    </div>
  );
}
