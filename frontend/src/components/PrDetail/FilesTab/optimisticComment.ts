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
  // The refetch generation in effect when this placeholder was created (#603
  // item C). A strictly-greater current generation means a refetch has landed
  // *since* creation — the precondition for the bounded fallback eviction below.
  // Optional for back-compat with older test fixtures; absent is treated as 0.
  createdGen?: number;
  // The de-dup key. Equals the real comment's `databaseId` once the refetch
  // lands; the placeholder is dropped when that match appears.
  postedCommentId: number;
}

// #603 item C. `databaseId` is genuinely nullable and real GitHub responses ship
// `databaseId: null` (fixture pr19-graphql-response.json), so a posted comment
// can surface without it — the databaseId fast-path can then never match and the
// dimmed placeholder would live forever as a visible duplicate. Bound it: once a
// refetch has landed after the placeholder was created AND the placeholder has
// aged past this window, evict it regardless of databaseId.
export const OPTIMISTIC_FALLBACK_MAX_AGE_MS = 4000;

// Pure eviction predicate (extracted for direct unit testing). Returns the
// surviving placeholders; preserves reference identity when nothing is evicted
// so callers' downstream memos don't churn.
//   - fast path: drop on a databaseId === postedCommentId match;
//   - fallback: drop when a refetch has landed since creation (currentGen >
//     createdGen) AND the placeholder has aged past maxAgeMs.
export function pruneOptimistic(
  prev: OptimisticComment[],
  realComments: ReadonlyArray<{ databaseId?: number | null }>,
  currentGen: number,
  nowMs: number,
  maxAgeMs: number = OPTIMISTIC_FALLBACK_MAX_AGE_MS,
): OptimisticComment[] {
  const next = prev.filter((opt) => {
    if (realComments.some((c) => c.databaseId != null && c.databaseId === opt.postedCommentId)) {
      return false; // fast path: real comment with matching id landed
    }
    const refetchLanded = currentGen > (opt.createdGen ?? 0);
    const aged = nowMs - Date.parse(opt.createdAt) > maxAgeMs;
    return !(refetchLanded && aged);
  });
  return next.length === prev.length ? prev : next;
}
