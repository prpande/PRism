import { useEffect, useState } from 'react';
import type { DraftCommentDto, IssueCommentDto, PrReference } from '../../../api/types';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { PrRootReplyComposer } from '../Composer/PrRootReplyComposer';
import { MarkAllReadButton } from './MarkAllReadButton';
import styles from './PrRootConversation.module.css';

export interface PrRootConversationReplyContext {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  // Pre-existing PR-root draft (filePath/lineNumber/anchoredSha all null per
  // spec § 5.6) hydrates the composer with its body when the user opens the
  // reply panel. Mirrors the inline-composer hydration path.
  existingPrRootDraft: DraftCommentDto | null;
  registerOpenComposer: (draftId: string) => () => void;
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
      {comments.map((comment) => (
        <article key={comment.id} className={styles.prRootComment} data-testid="pr-root-comment">
          <header className={styles.prRootCommentMeta}>
            <span className={styles.prRootCommentAuthor}>{comment.author}</span>
            <time className={styles.prRootCommentTime} dateTime={comment.createdAt}>
              {new Date(comment.createdAt).toLocaleDateString()}
            </time>
          </header>
          <div className={styles.prRootCommentBody}>
            <MarkdownRenderer source={comment.body} />
          </div>
        </article>
      ))}

      {replyContext ? (
        <PrRootConversationActions replyContext={replyContext} />
      ) : (
        // Rendered when the conversation is mounted in a read-only context
        // (e.g., a future Drafts-tab preview slot). The S3-shipped message
        // ("Reply lands when…S4") was retired with PR5; the new fallback
        // is stable across slices.
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
  // `useState(initialValue)` is frozen at first render. When a cross-tab
  // refetch later populates `existingPrRootDraft` (PR6 will wire that path),
  // the useEffect below re-syncs so the composer auto-opens with the
  // persisted body. Without it, the freshly-arrived draft is silently
  // dropped and the user sees only the Reply button.
  const [composerOpen, setComposerOpen] = useState<boolean>(!!existingPrRootDraft);
  const [draftId, setDraftId] = useState<string | null>(existingPrRootDraft?.id ?? null);

  useEffect(() => {
    if (!existingPrRootDraft) return;
    setDraftId(existingPrRootDraft.id);
    setComposerOpen(true);
  }, [existingPrRootDraft?.id]);

  const handleReplyClick = () => setComposerOpen(true);
  const handleClose = () => {
    setComposerOpen(false);
    onComposerClose();
  };

  return (
    <div className={styles.prRootConversationActions}>
      <div className={styles.prRootConversationActionsRow}>
        {!composerOpen && (
          <button type="button" className={styles.prRootReplyButton} onClick={handleReplyClick}>
            Reply
          </button>
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
