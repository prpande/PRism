import type { IssueCommentDto } from '../../../api/types';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';

interface PrRootConversationProps {
  comments: IssueCommentDto[];
}

export function PrRootConversation({ comments }: PrRootConversationProps) {
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
      <p className="pr-root-conversation-footer muted">
        Reply lands when the comment composer ships in S4.
      </p>
    </section>
  );
}
