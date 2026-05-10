import { useCallback, useEffect, useRef, useState } from 'react';
import { getDraft } from '../api/draft';
import type {
  DraftCommentDto,
  DraftReplyDto,
  PrReference,
  ReviewSessionDto,
} from '../api/types';

export type DraftSessionStatus = 'loading' | 'ready' | 'error';

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
  // Refcount-based registration. Multiple composers can open the same draft
  // id (Files tab + Drafts tab); the predicate stays truthy until the last
  // one unmounts. Returns a cleanup that decrements.
  registerOpenComposer: (draftId: string) => () => void;
  outOfBandToast: OutOfBandUpdate | null;
  clearOutOfBandToast: () => void;
}

export function useDraftSession(prRef: PrReference): UseDraftSessionResult {
  const [session, setSession] = useState<ReviewSessionDto | null>(null);
  const [status, setStatus] = useState<DraftSessionStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [outOfBandToast, setOutOfBandToast] = useState<OutOfBandUpdate | null>(null);

  const openComposers = useRef(new Map<string, number>());
  const isOpen = useCallback((id: string) => (openComposers.current.get(id) ?? 0) > 0, []);

  const registerOpenComposer = useCallback((draftId: string): (() => void) => {
    const m = openComposers.current;
    m.set(draftId, (m.get(draftId) ?? 0) + 1);
    return () => {
      const next = (m.get(draftId) ?? 0) - 1;
      if (next <= 0) m.delete(draftId);
      else m.set(draftId, next);
    };
  }, []);

  // Sessionref so async refetch reads the freshest local state on merge.
  const sessionRef = useRef<ReviewSessionDto | null>(null);
  sessionRef.current = session;

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
  useEffect(() => {
    setSession(null);
    setStatus('loading');
    setOutOfBandToast(null);
    openComposers.current.clear();
    let cancelled = false;
    void (async () => {
      try {
        const server = await getDraft(prRef);
        if (cancelled) return;
        setSession(server);
        setStatus('ready');
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
