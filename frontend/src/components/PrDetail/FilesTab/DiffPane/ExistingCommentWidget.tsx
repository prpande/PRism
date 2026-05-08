import type { ReviewThreadDto } from '../../../../api/types';
import { MarkdownRenderer } from '../../../Markdown/MarkdownRenderer';

export interface ExistingCommentWidgetProps {
  threads: ReviewThreadDto[];
}

export function ExistingCommentWidget({ threads }: ExistingCommentWidgetProps) {
  if (threads.length === 0) return null;

  return (
    <div className="comment-widget">
      {threads.map((thread) => (
        <div
          key={thread.threadId}
          className={`comment-thread ${thread.isResolved ? 'comment-thread--resolved' : ''}`}
        >
          {thread.comments.map((comment) => (
            <div key={comment.commentId} className="comment-entry">
              <div className="comment-meta">
                <span className="comment-author">{comment.author}</span>
                <time className="comment-time" dateTime={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleDateString()}
                </time>
              </div>
              <div className="comment-body">
                <MarkdownRenderer source={comment.body} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
