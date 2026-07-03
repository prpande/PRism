import type { PrReference, ReviewThreadDto } from '../../../../api/types';
import { CommentCard } from '../../Comment/CommentCard';
import { CollapsedComposerAffordance } from '../../Composer/CollapsedComposerAffordance';
import { ReplyComposer } from '../../Composer/ReplyComposer';
import styles from './ExistingCommentWidget.module.css';
import {
  computeAnyOtherDraftsStaged,
  type ComposerOwnerKey,
} from '../../../../hooks/useDraftSession';
import { useDraftBackedDisclosure } from '../../../../hooks/useDraftBackedDisclosure';
import { useReplyData } from '../ReplyDataContext';
import { ThreadDisclosureHeader } from './ThreadDisclosureHeader';
import { stripMarkdown } from '../../HotspotsTab/stripMarkdown';

// #327 Task 13 — the STABLE half of the split reply wiring: identity-stable
// callbacks plus the rarely-changing scalars (prRef/prState/readOnly). FilesTab
// builds it once (latest-ref-backed callbacks) so it can cross the memoized
// diff rows without breaking their React.memo bail on every autosave refetch.
// The per-thread DATA (draftComments/draftReplies/postingInProgress/
// optimisticByThread) flows through the reactive ReplyDataContext channel
// exclusively — mount a ReplyDataProvider to supply it (unit tests included).
export interface ExistingCommentWidgetReplyContext {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  // Called after the reply composer closes so the parent can refetch the
  // session (mirrors the on-close path the inline composer uses for the
  // own-tab refresh-after-write case).
  onReplyComposerClose: () => void;
  // Spec § 5.7a. Forwarded to ReplyComposer; disables textarea + save.
  readOnly?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  // Fired after a successful post-now so the parent refetches the session and
  // the just-posted comment surfaces. 11b passes the posted body so the parent
  // can stash an optimistic placeholder for this thread.
  onReplyPosted?: (threadId: string, postedCommentId: number, body: string) => void;
  // #571 — reloads PR detail (stable function from usePrDetailContext). Wired
  // by the thread-resolution control (Task 12) so a resolve/unresolve action
  // reflects the server's response without waiting on the SSE round-trip.
  reload: () => void;
}

export interface ThreadCollapseControl {
  isCollapsed: (threadId: string, isResolved: boolean) => boolean;
  toggle: (threadId: string, isResolved: boolean) => void;
  // #571 — drops threadId's entry from the collapse-override map so a
  // resolve/unresolve action falls back to the isResolved default instead of
  // sticking to whatever the user last toggled.
  clearCollapseOverride: (threadId: string) => void;
}

export interface ExistingCommentWidgetProps {
  threads: ReviewThreadDto[];
  // When omitted, the widget renders read-only (no Reply button, no composer).
  // Tests of pure thread rendering omit this; FilesTab provides it.
  replyContext?: ExistingCommentWidgetReplyContext;
  // When omitted, all threads render fully expanded (back-compat).
  collapse?: ThreadCollapseControl;
}

export function ExistingCommentWidget({
  threads,
  replyContext,
  collapse,
}: ExistingCommentWidgetProps) {
  if (threads.length === 0) return null;

  return (
    <div className={`comment-widget ${styles.commentWidget}`} data-testid="comment-widget">
      {threads.map((thread) => (
        <ThreadView
          key={thread.threadId}
          thread={thread}
          replyContext={replyContext}
          collapse={collapse}
        />
      ))}
    </div>
  );
}

function ThreadView({
  thread,
  replyContext,
  collapse,
}: {
  thread: ReviewThreadDto;
  replyContext: ExistingCommentWidgetReplyContext | undefined;
  collapse: ThreadCollapseControl | undefined;
}) {
  // #327 Task 13 — per-thread reply DATA arrives through the reactive
  // ReplyDataContext channel (provided by FilesTab above DiffPane); the
  // replyContext prop is the stable callbacks bag. The consumer sits HERE —
  // below the memoized DiffLineRow — so a draft-session refetch re-renders
  // only thread widgets, never bailed diff rows. Renders without data (empty
  // defaults) when no provider is mounted (pure-rendering unit harnesses).
  const replyData = useReplyData();
  const draftReplies = replyData?.draftReplies ?? [];
  const draftComments = replyData?.draftComments ?? [];
  const postingInProgress = replyData?.postingInProgress ?? false;
  const optimisticByThread = replyData?.optimisticByThread;

  // Hydrate from any existing draft reply against this thread. A user who
  // returns to the page mid-flow sees a "Reply (saved draft)" affordance
  // and the composer pre-populated with the persisted body when opened.
  const existingDraft = draftReplies.find((r) => r.parentThreadId === thread.threadId);

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
  const optimisticForThread = (optimisticByThread?.[thread.threadId] ?? []).filter(
    (o) => !thread.comments.some((c) => c.databaseId != null && c.databaseId === o.postedCommentId),
  );

  const collapsed = collapse?.isCollapsed(thread.threadId, thread.isResolved) ?? false;
  const bodyId = `thread-body-${thread.threadId}`;
  const first = thread.comments[0];
  const snippet = collapsed && first ? stripMarkdown(first.body).slice(0, 200) : undefined;

  return (
    <div
      className={`comment-thread${thread.isResolved ? ' comment-thread--resolved' : ''} ${styles.commentThread}`}
      data-thread-id={thread.threadId}
    >
      <ThreadDisclosureHeader
        collapsed={collapsed}
        onToggle={() => collapse?.toggle(thread.threadId, thread.isResolved)}
        bodyId={bodyId}
        author={first?.author}
        avatarUrl={first?.avatarUrl}
        snippet={snippet}
        commentCount={thread.comments.length}
        isResolved={thread.isResolved}
        filePath={thread.filePath}
        lineNumber={thread.lineNumber}
      />

      {!collapsed && (
        <div id={bodyId} className={styles.body}>
          {thread.comments.map((comment) => (
            <CommentCard
              key={comment.commentId}
              author={comment.author}
              avatarUrl={comment.avatarUrl}
              createdAt={comment.createdAt}
              body={comment.body}
              density="comfortable"
              data-testid="inline-comment-card"
            />
          ))}

          {optimisticForThread.map((o) => (
            <CommentCard
              key={o.clientId}
              author={o.author}
              createdAt={o.createdAt}
              body={o.body}
              density="comfortable"
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
                draftComments,
                draftReplies,
                draftReplyId,
                postingInProgress,
              )}
              beginPosting={replyContext.beginPosting}
              endPosting={replyContext.endPosting}
              onPosted={(id, postedBody) =>
                replyContext.onReplyPosted?.(thread.threadId, id, postedBody)
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
