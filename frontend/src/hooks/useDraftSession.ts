import { useCallback, useEffect, useRef, useState } from 'react';
import { getDraft } from '../api/draft';
import { prRefKey } from '../api/types';
import type { DraftCommentDto, DraftReplyDto, PrReference, ReviewSessionDto } from '../api/types';
import { isPrRootDraft } from '../components/PrDetail/draftKinds';

// Are there OTHER staged drafts besides this composer's own? During a post-now (postingInProgress),
// suppress entirely: by D3 post-now is only reachable when no other real drafts are staged, so the
// only draft present mid-post is the transient one — never flicker other composers. (#302 D3 + F3/F5.)
export function computeAnyOtherDraftsStaged(
  comments: DraftCommentDto[],
  replies: DraftReplyDto[],
  ownDraftId: string | null,
  postingInProgress: boolean,
): boolean {
  if (postingInProgress) return false;
  return comments.some((d) => d.id !== ownDraftId) || replies.some((r) => r.id !== ownDraftId);
}

export type DraftSessionStatus = 'loading' | 'ready' | 'error';

// Identifies which composer surface holds an open draft. 'reply-composer' and
// 'submit-dialog' are the PR-root–owning surfaces; 'files-tab' and
// 'drafts-tab' are the inline-comment surfaces.
export type ComposerOwnerKey = 'reply-composer' | 'submit-dialog' | 'files-tab' | 'drafts-tab';

// Surfaced when a remote tab (or the reload pipeline) edits a draft body the
// local tab is NOT actively composing. The toast is the user's signal that
// the Drafts tab content shifted under them; clearing it is the "ack" action.
export interface OutOfBandUpdate {
  draftId: string;
  filePath: string | null;
}

export interface UseDraftSessionResult {
  session: ReviewSessionDto | null;
  status: DraftSessionStatus;
  error: Error | null;
  refetch: () => Promise<void>;
  // Set-based registration. Multiple composers can open the same draft id
  // (Files tab + Drafts tab); the predicate stays truthy until the last one
  // unmounts. ownerKey identifies which surface holds the composer.
  // Returns a cleanup that removes the ownerKey from the set.
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  // Returns the ownerKey of the first composer that holds the PR-root draft
  // (filePath===null && lineNumber===null), or null if no composer is open.
  getPrRootHolder: () => ComposerOwnerKey | null;
  outOfBandToast: OutOfBandUpdate | null;
  clearOutOfBandToast: () => void;
  // Ref-counted suppressor: while any post-now is in flight, postingInProgress
  // is true, and computeAnyOtherDraftsStaged returns false so other open
  // composers never flicker into "review in progress". (#302 F3/F5.)
  postingInProgress: boolean;
  beginPosting: () => void;
  endPosting: () => void;
  // #744 — optimistic local mutators. They let a confirmed create/discard
  // reflect in the shared session immediately, without waiting on the trailing
  // reconciliation refetch. Both are id-keyed, idempotent, and touch only the
  // draft arrays; the refetch remains the reconciliation authority.
  removeDraftLocally: (id: string) => void;
  insertDraftLocally: (draft: DraftCommentDto | DraftReplyDto) => void;
}

export function useDraftSession(prRef: PrReference): UseDraftSessionResult {
  const [session, setSession] = useState<ReviewSessionDto | null>(null);
  const [status, setStatus] = useState<DraftSessionStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [outOfBandToast, setOutOfBandToast] = useState<OutOfBandUpdate | null>(null);

  const openComposers = useRef(new Map<string, Set<ComposerOwnerKey>>());
  const isOpen = useCallback((id: string) => (openComposers.current.get(id)?.size ?? 0) > 0, []);

  // Ref-counted posting suppressor (#302 F3/F5). Multiple simultaneous post-now
  // calls (e.g. rapid double-tap) each hold a count; postingInProgress stays true
  // until the last one resolves.
  const postingCountRef = useRef(0);
  const [postingInProgress, setPostingInProgress] = useState(false);
  const beginPosting = useCallback(() => {
    postingCountRef.current += 1;
    setPostingInProgress(true);
  }, []);
  const endPosting = useCallback(() => {
    postingCountRef.current = Math.max(0, postingCountRef.current - 1);
    setPostingInProgress(postingCountRef.current > 0);
  }, []);

  const registerOpenComposer = useCallback(
    (draftId: string, ownerKey: ComposerOwnerKey): (() => void) => {
      const m = openComposers.current;
      let set = m.get(draftId);
      if (!set) {
        set = new Set<ComposerOwnerKey>();
        m.set(draftId, set);
      }
      set.add(ownerKey);
      return () => {
        const s = m.get(draftId);
        if (!s) return;
        s.delete(ownerKey);
        if (s.size === 0) m.delete(draftId);
      };
    },
    [],
  );

  // Sessionref so async refetch reads the freshest local state on merge.
  const sessionRef = useRef<ReviewSessionDto | null>(null);
  sessionRef.current = session;

  // #612 C — generation guard for the imperative refetch. The mount effect below
  // guards its async resolution with a local `cancelled` flag; refetch needs the
  // equivalent or a late refetch for the previous PR clobbers the new PR's session
  // (refetch is wired to SSE subscribers and useReconcile.onReloadComplete). The
  // load-bearing guard is the prRef key — a primitive, compared against a
  // render-tracked ref — NOT the closure's own prRef (stale-by-design, would always
  // match) and NOT object identity (prRef is a fresh literal each render, #331).
  const activePrKeyRef = useRef('');
  activePrKeyRef.current = prRefKey(prRef);
  // Secondary backstop: a refetch that resolves after the hook unmounts (an SSE /
  // onReloadComplete callback firing post-teardown) must not setState on a dead hook.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const getPrRootHolder = useCallback((): ComposerOwnerKey | null => {
    const rootDraft = session?.draftComments.find(isPrRootDraft);
    if (!rootDraft) return null;
    const set = openComposers.current.get(rootDraft.id);
    if (!set || set.size === 0) return null;
    // Return the first ownerKey in insertion order.
    return set.values().next().value ?? null;
  }, [session]);

  const refetch = useCallback(async () => {
    const key = activePrKeyRef.current;
    try {
      const server = await getDraft(prRef);
      // Drop the result if the active PR changed mid-flight or the hook unmounted.
      if (!mountedRef.current || activePrKeyRef.current !== key) return;
      setSession(mergeSession(sessionRef.current, server, isOpen, setOutOfBandToast));
      setStatus('ready');
      setError(null);
    } catch (e) {
      if (!mountedRef.current || activePrKeyRef.current !== key) return;
      setError(e as Error);
      setStatus('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [prRef.owner, prRef.repo, prRef.number, isOpen]);

  // Reset to loading on prRef change so a stale local session for the
  // previous PR doesn't get diffed against the new PR's server response.
  // Clearing `error` is also load-bearing: if the prior PR's load failed,
  // a successful load on the new PR shouldn't leave a stale error visible
  // to consumers. Same on the success path of refetch().
  useEffect(() => {
    setSession(null);
    setStatus('loading');
    setError(null);
    setOutOfBandToast(null);
    openComposers.current.clear();
    let cancelled = false;
    void (async () => {
      try {
        const server = await getDraft(prRef);
        if (cancelled) return;
        setSession(server);
        setStatus('ready');
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e as Error);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [prRef.owner, prRef.repo, prRef.number]);

  const clearOutOfBandToast = useCallback(() => setOutOfBandToast(null), []);

  // #744 — optimistic discard: splice the id from BOTH draft arrays (ids are
  // unique across comments/replies, but removing from both is unconditionally
  // safe and keeps callers from needing a kind hint). No-op on null session or
  // absent id; idempotent.
  const removeDraftLocally = useCallback((id: string) => {
    setSession((prev) => {
      if (!prev) return prev;
      const draftComments = prev.draftComments.filter((c) => c.id !== id);
      const draftReplies = prev.draftReplies.filter((r) => r.id !== id);
      if (
        draftComments.length === prev.draftComments.length &&
        draftReplies.length === prev.draftReplies.length
      ) {
        return prev; // nothing removed — keep identity so consumers don't re-render
      }
      return { ...prev, draftComments, draftReplies };
    });
  }, []);

  // #744 — optimistic create: insert (or replace, dedup-by-id) a just-created
  // draft. Reply DTOs carry `parentThreadId`; everything else is a comment. The
  // dedup guarantees a refetch that already landed the server row can't produce
  // a duplicate. No-op on null session.
  const insertDraftLocally = useCallback((draft: DraftCommentDto | DraftReplyDto) => {
    setSession((prev) => {
      if (!prev) return prev;
      if ('parentThreadId' in draft) {
        const rest = prev.draftReplies.filter((r) => r.id !== draft.id);
        return { ...prev, draftReplies: [...rest, draft] };
      }
      const rest = prev.draftComments.filter((c) => c.id !== draft.id);
      return { ...prev, draftComments: [...rest, draft] };
    });
  }, []);

  return {
    session,
    status,
    error,
    refetch,
    registerOpenComposer,
    getPrRootHolder,
    outOfBandToast,
    clearOutOfBandToast,
    postingInProgress,
    beginPosting,
    endPosting,
    removeDraftLocally,
    insertDraftLocally,
  };
}

// Diff-and-prefer merge (spec § 5.2). On first fetch (`local === null`) the
// server result is returned verbatim. On subsequent refetches:
//  - id present in both AND a composer is open: keep local body, accept
//    server status / isOverriddenStale.
//  - id present in both AND no composer open: server wins. If the body
//    actually changed, fire an out-of-band toast.
//  - server-only: add to result.
//  - local-only: drop (composer's next save 404s and recovers via Task 37).
function mergeSession(
  local: ReviewSessionDto | null,
  server: ReviewSessionDto,
  isOpen: (id: string) => boolean,
  fireOutOfBand: (u: OutOfBandUpdate) => void,
): ReviewSessionDto {
  if (local === null) return server;
  return {
    ...server,
    draftComments: mergeComments(local.draftComments, server.draftComments, isOpen, fireOutOfBand),
    draftReplies: mergeReplies(local.draftReplies, server.draftReplies, isOpen, fireOutOfBand),
  };
}

function mergeComments(
  local: DraftCommentDto[],
  server: DraftCommentDto[],
  isOpen: (id: string) => boolean,
  fireOutOfBand: (u: OutOfBandUpdate) => void,
): DraftCommentDto[] {
  const localById = new Map(local.map((d) => [d.id, d]));
  const result: DraftCommentDto[] = [];
  for (const s of server) {
    const l = localById.get(s.id);
    if (!l) {
      result.push(s);
      continue;
    }
    if (isOpen(s.id)) {
      result.push({ ...s, bodyMarkdown: l.bodyMarkdown });
    } else {
      if (l.bodyMarkdown !== s.bodyMarkdown) {
        fireOutOfBand({ draftId: s.id, filePath: s.filePath });
      }
      result.push(s);
    }
  }
  return result;
}

function mergeReplies(
  local: DraftReplyDto[],
  server: DraftReplyDto[],
  isOpen: (id: string) => boolean,
  fireOutOfBand: (u: OutOfBandUpdate) => void,
): DraftReplyDto[] {
  const localById = new Map(local.map((d) => [d.id, d]));
  const result: DraftReplyDto[] = [];
  for (const s of server) {
    const l = localById.get(s.id);
    if (!l) {
      result.push(s);
      continue;
    }
    if (isOpen(s.id)) {
      result.push({ ...s, bodyMarkdown: l.bodyMarkdown });
    } else {
      if (l.bodyMarkdown !== s.bodyMarkdown) {
        fireOutOfBand({ draftId: s.id, filePath: null });
      }
      result.push(s);
    }
  }
  return result;
}
