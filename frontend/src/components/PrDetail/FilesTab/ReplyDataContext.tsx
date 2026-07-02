import { createContext, useContext } from 'react';
import type { DraftCommentDto, DraftReplyDto } from '../../../api/types';
import type { OptimisticComment } from './optimisticComment';

// #327 Task 13 — the REACTIVE per-thread data channel, the data half of the
// replyContext split (the callbacks half stays a stable prop bag; see
// ExistingCommentWidgetReplyContext). `useDraftSession`'s diff-and-prefer merge
// rebuilds `draftComments`/`draftReplies` on every autosave refetch, so this
// data CANNOT ride the memoized diff rows' props without churning every
// unified-mode DiffLineRow on each autosave (defeating the Task 12 row bail) —
// and it cannot be a ref read either, because a draft reply arriving via a
// refetch (cross-tab hydration) must re-render the affected thread widget.
//
// FilesTab provides one memoized value above DiffPane, rebuilt only when the
// underlying pieces change; ThreadView (inside ExistingCommentWidget) consumes
// it and selects its own thread's slice. Only context subscribers re-render on
// a change — rows without thread data never see it, so the row-level memo bail
// (FilesTab.renderCount.perf.test.tsx assertion (a)) is preserved.
export interface ReplyData {
  draftComments: DraftCommentDto[];
  draftReplies: DraftReplyDto[];
  postingInProgress: boolean;
  // Optimistic reply placeholders keyed by threadId (#302 Task 11b) — see
  // useOptimisticComments / optimisticComment.ts.
  optimisticByThread: Record<string, OptimisticComment[]>;
}

const ReplyDataContext = createContext<ReplyData | null>(null);

export const ReplyDataProvider = ReplyDataContext.Provider;

// Null when no provider is mounted (DiffPane / widget unit-test harnesses) —
// consumers then fall back to the data fields still allowed on the
// replyContext prop.
export function useReplyData(): ReplyData | null {
  return useContext(ReplyDataContext);
}
