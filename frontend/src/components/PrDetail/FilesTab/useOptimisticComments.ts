import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { InlineAnchor } from '../Composer/InlineCommentComposer';
import {
  pruneOptimistic,
  OPTIMISTIC_FALLBACK_MAX_AGE_MS,
  type OptimisticComment,
} from './optimisticComment';

// #327 slice 2 — the optimistic-comment subsystem extracted from FilesTab.
// Owns the placeholder state, the refetch-generation counter, the prune
// effect (fast-path + bounded fallback timer), the per-thread grouping, and
// the per-line placeholder filter. The pure eviction predicate stays in
// optimisticComment.ts.

// #302 — no viewer login on PrDetailDto; optimistic placeholders are by
// construction the current user's.
const VIEWER_LABEL = 'You';

// Unique React key per optimistic placeholder. crypto.randomUUID where
// available (jsdom + modern browsers), else a small monotonic fallback so the
// function is total in bare-node test contexts.
// NOTE: optimisticCounter is a module-scoped fallback only used when
// crypto.randomUUID is unavailable; a process-global monotonic counter keeps
// ids unique even across multiple kept-alive FilesTab instances.
let optimisticCounter = 0;
function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  optimisticCounter += 1;
  return `optimistic-${optimisticCounter}`;
}

// Structural view of prDetail.reviewComments — only the de-dup key is read.
type RealCommentLike = { databaseId?: number | null };
type ReviewThreadLike = { comments: ReadonlyArray<RealCommentLike> };

export function useOptimisticComments(reviewThreads: ReadonlyArray<ReviewThreadLike>): {
  optimisticByThread: Record<string, OptimisticComment[]>;
  // #327 Task 12 — the UN-DEDUPED new-inline placeholder locations (threadId
  // === null, still awaiting their real comment), with each placeholder's
  // anchorKey already parsed into structured fields so the anchorKey string
  // format stays private to this subsystem. Feeds FilesTab's activeComposerKey.
  newInlineLocations: { filePath: string; lineNumber: number; clientId: string }[];
  placeholdersForLine: (filePath: string, lineNumber: number) => OptimisticComment[];
  notePosted: (
    anchor: Pick<InlineAnchor, 'filePath' | 'lineNumber' | 'side'>,
    postedCommentId: number,
    body: string,
  ) => void;
  noteReplyPosted: (threadId: string, postedCommentId: number, body: string) => void;
} {
  // #302 Task 11b — optimistic placeholders for just-posted comments. A post-now
  // pushes an entry here so the comment appears instantly (dimmed) instead of
  // after the ~300-800ms refetch round-trip. Each entry is dropped once the
  // refetched reviewComments contain a real comment whose `databaseId` equals
  // the entry's `postedCommentId` (de-dup keyed on databaseId — body text is
  // NEVER the key; see optimisticComment.ts).
  const [optimistic, setOptimistic] = useState<OptimisticComment[]>([]);

  // #603 item C — refetch generation. allRealComments is a fresh array on every
  // reviewComments refetch, so bumping a counter here lets the cleanup below tell
  // whether a refetch has landed *since* a given placeholder was created (the
  // precondition for the bounded fallback eviction).
  const refetchGenRef = useRef(0);

  // Hoisted: single flat list of all real comments — used both by the optimistic
  // cleanup effect and by placeholdersForLine's placeholder filter (avoids an
  // O(lines×comments) flatMap per render call).
  const allRealComments = useMemo(() => reviewThreads.flatMap((t) => t.comments), [reviewThreads]);

  // Cleanup effect: when a refetch lands, drop optimistic placeholders. Fast
  // path is the databaseId === postedCommentId match (ExistingCommentWidget
  // repeats it at render time as belt-and-suspenders). Fallback (#603 item C):
  // a posted comment can surface with databaseId === null (real GitHub
  // responses do), which the fast-path can never match — so once a refetch has
  // landed after the placeholder was created AND it has aged past the bound,
  // evict it anyway, preventing a permanent visible duplicate. A one-shot timer
  // re-runs the prune at the age bound so a databaseId-less placeholder still
  // evicts even without a further refetch.
  useEffect(() => {
    refetchGenRef.current += 1;
    const gen = refetchGenRef.current;
    setOptimistic((prev) => pruneOptimistic(prev, allRealComments, gen, Date.now()));
    const timer = setTimeout(() => {
      setOptimistic((prev) =>
        pruneOptimistic(prev, allRealComments, refetchGenRef.current, Date.now()),
      );
    }, OPTIMISTIC_FALLBACK_MAX_AGE_MS);
    return () => clearTimeout(timer);
  }, [allRealComments]);

  // Group reply/existing-thread optimistic entries by threadId for the reply
  // context. New-inline entries (threadId === null) are rendered separately at
  // their anchor line via placeholdersForLine.
  const optimisticByThread = useMemo(() => {
    const map: Record<string, OptimisticComment[]> = {};
    for (const o of optimistic) {
      if (o.threadId == null) continue;
      (map[o.threadId] ??= []).push(o);
    }
    return map;
  }, [optimistic]);

  // #327 Task 12 — new-inline placeholders awaiting their real comment,
  // deliberately UN-deduped (unlike placeholdersForLine): the composer location
  // must stay marked in activeComposerKey through the placeholder→real handoff
  // window, so the row hosting the handoff keeps re-rendering until the prune
  // effect actually drops the placeholder. Memoized so identity is stable while
  // `optimistic` is unchanged (newInlineLocations' memo keys on it).
  const newInlinePlaceholders = useMemo(
    () => optimistic.filter((o) => o.threadId == null),
    [optimistic],
  );

  // Structured locations for the un-deduped new-inline placeholders. anchorKey
  // is `${filePath}:${lineNumber}:${side}` (see notePosted below) and filePath
  // may itself contain ':', so parse from the RIGHT: last ':' delimits the
  // side, the ':' before it delimits the line number. Parsing here keeps the
  // anchorKey string format private to this subsystem — FilesTab consumes
  // structured fields, no string surgery.
  const newInlineLocations = useMemo(
    () =>
      newInlinePlaceholders.flatMap((o) => {
        if (o.anchorKey == null) return [];
        const sideSep = o.anchorKey.lastIndexOf(':');
        const lineSep = sideSep === -1 ? -1 : o.anchorKey.lastIndexOf(':', sideSep - 1);
        if (lineSep === -1) return []; // malformed anchorKey — skip rather than emit junk
        const lineNumber = Number(o.anchorKey.slice(lineSep + 1, sideSep));
        if (!Number.isFinite(lineNumber)) return [];
        return [
          {
            filePath: o.anchorKey.slice(0, lineSep),
            lineNumber,
            clientId: o.clientId,
          },
        ];
      }),
    [newInlinePlaceholders],
  );

  // #302 Task 11b — new-inline optimistic placeholders for a diff line. Matched
  // by filePath:lineNumber (side-agnostic for placement; the line is the
  // anchor the user sees). De-dup by databaseId vs the now-real reviewComments
  // (so the placeholder vanishes the instant the refetch lands its comment).
  // allRealComments is a hoisted useMemo (closure capture) — no per-line flatMap.
  const placeholdersForLine = useCallback(
    (filePath: string, lineNumber: number) =>
      newInlinePlaceholders.filter(
        (o) =>
          o.anchorKey != null &&
          o.anchorKey.startsWith(`${filePath}:${lineNumber}:`) &&
          !allRealComments.some((c) => c.databaseId != null && c.databaseId === o.postedCommentId),
      ),
    [newInlinePlaceholders, allRealComments],
  );

  // New inline thread — no server thread id yet. Anchor the placeholder
  // to this line so renderComposerForLine can place it after the
  // composer closes. Keyed by filePath:lineNumber:side.
  const notePosted = useCallback(
    (
      anchor: Pick<InlineAnchor, 'filePath' | 'lineNumber' | 'side'>,
      postedCommentId: number,
      body: string,
    ) => {
      const anchorKey = `${anchor.filePath}:${anchor.lineNumber}:${anchor.side}`;
      setOptimistic((o) => [
        ...o,
        {
          clientId: newClientId(),
          threadId: null,
          anchorKey,
          body,
          author: VIEWER_LABEL,
          createdAt: new Date().toISOString(),
          createdGen: refetchGenRef.current,
          postedCommentId,
        },
      ]);
    },
    [],
  );

  // #302 Task 11b — stash an optimistic placeholder for the thread. The
  // placeholder is de-duped against the refetched comment by databaseId
  // (postedCommentId), here and at render in ExistingCommentWidget.
  const noteReplyPosted = useCallback((threadId: string, postedCommentId: number, body: string) => {
    setOptimistic((o) => [
      ...o,
      {
        clientId: newClientId(),
        threadId,
        body,
        author: VIEWER_LABEL,
        createdAt: new Date().toISOString(),
        createdGen: refetchGenRef.current,
        postedCommentId,
      },
    ]);
  }, []);

  return {
    optimisticByThread,
    newInlineLocations,
    placeholdersForLine,
    notePosted,
    noteReplyPosted,
  };
}
