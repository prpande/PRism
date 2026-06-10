// #302 Task 11b — optimistic inline-comment placeholder.
//
// When the user clicks "Comment" (post-now), the real comment surfaces only
// after the post + a draft-session refetch round-trips (~300-800ms). To make
// the post feel instant we render a dimmed placeholder card immediately, then
// drop it once the refetched data contains the real comment.
//
// CRITICAL CORRECTNESS PROPERTY: the placeholder is de-duped against the
// refetched real comment by `databaseId` === `postedCommentId` — the numeric
// REST id GitHub assigns the just-posted comment (ReviewCommentDto.databaseId,
// PrDetailDto.reviewComments[].comments[].databaseId; postComment returns it as
// `postedCommentId`). Body text is NOT the de-dup key: two distinct comments
// can share a body, so matching on text would wrongly hide a real comment or
// keep a stale placeholder. Body is carried only to render the placeholder.
export interface OptimisticComment {
  // Stable React key for the placeholder card. Unique per placeholder.
  clientId: string;
  // The thread this placeholder belongs to. `null` for a brand-new inline
  // thread that has no server thread id yet (anchored by `anchorKey` instead).
  threadId: string | null;
  // For new inline threads only: `${filePath}:${lineNumber}:${side}` — locates
  // the placeholder at the diff line where the composer was.
  anchorKey?: string;
  body: string;
  author: string;
  // Captured once at creation so repeated renders don't jitter the timestamp.
  createdAt: string;
  // The de-dup key. Equals the real comment's `databaseId` once the refetch
  // lands; the placeholder is dropped when that match appears.
  postedCommentId: number;
}
