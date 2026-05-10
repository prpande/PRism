import { useEffect, useState } from 'react';
import type { DraftCommentDto, IssueCommentDto, PrReference } from '../../../api/types';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { PrRootReplyComposer } from '../Composer/PrRootReplyComposer';
import { MarkAllReadButton } from './MarkAllReadButton';

export interface PrRootConversationReplyContext {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  // Pre-existing PR-root draft (filePath/lineNumber/anchoredSha all null per
  // spec § 5.6) hydrates the composer with its body when the user opens the
  // reply panel. Mirrors the inline-composer hydration path.
  existingPrRootDraft: DraftCommentDto | null;
  registerOpenComposer: (draftId: string) => () => void;
  onComposerClose: () => void;
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
    <section className="overview-card pr-root-conversation">
      {comments.map((comment) => (
        <article key={comment.id} className="pr-root-comment">
          <header className="pr-root-comment-meta">
            <span className="pr-root-comment-author">{comment.author}</span>
            <time className="pr-root-comment-time" dateTime={comment.createdAt}>
              {new Date(comment.createdAt).toLocaleDateString()}
            </time>
          </header>
          <div className="pr-root-comment-body">
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
        <p className="pr-root-conversation-footer muted">
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
  const { prRef, prState, existingPrRootDraft, registerOpenComposer, onComposerClose } =
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
    <div className="pr-root-conversation-actions">
      <div className="pr-root-conversation-actions-row">
        {!composerOpen && (
          <button type="button" className="pr-root-reply-button" onClick={handleReplyClick}>
            Reply
          </button>
        )}
        <MarkAllReadButton prRef={prRef} />
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
        />
      )}
    </div>
  );
}
