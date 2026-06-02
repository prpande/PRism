import { useCallback, useEffect, useRef, useState } from 'react';
import { getDraft } from '../api/draft';
import type { DraftCommentDto, DraftReplyDto, PrReference, ReviewSessionDto } from '../api/types';

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
}

export function useDraftSession(prRef: PrReference): UseDraftSessionResult {
  const [session, setSession] = useState<ReviewSessionDto | null>(null);
  const [status, setStatus] = useState<DraftSessionStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [outOfBandToast, setOutOfBandToast] = useState<OutOfBandUpdate | null>(null);

  const openComposers = useRef(new Map<string, Set<ComposerOwnerKey>>());
  const isOpen = useCallback((id: string) => (openComposers.current.get(id)?.size ?? 0) > 0, []);

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

  const getPrRootHolder = useCallback((): ComposerOwnerKey | null => {
    const prRootDraft = session?.draftComments.find(
      (d) => d.filePath === null && d.lineNumber === null,
    );
    if (!prRootDraft) return null;
    const set = openComposers.current.get(prRootDraft.id);
    if (!set || set.size === 0) return null;
    // Return the first ownerKey in insertion order.
    return set.values().next().value ?? null;
  }, [session]);

  const refetch = useCallback(async () => {
    try {
      const server = await getDraft(prRef);
      setSession(mergeSession(sessionRef.current, server, isOpen, setOutOfBandToast));
      setStatus('ready');
      setError(null);
    } catch (e) {
      setError(e as Error);
      setStatus('error');
    }
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
  }, [prRef.owner, prRef.repo, prRef.number]);

  const clearOutOfBandToast = useCallback(() => setOutOfBandToast(null), []);

  return {
    session,
    status,
    error,
    refetch,
    registerOpenComposer,
    getPrRootHolder,
    outOfBandToast,
    clearOutOfBandToast,
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
