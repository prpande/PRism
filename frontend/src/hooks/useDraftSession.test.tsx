import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDraftSession } from './useDraftSession';
import * as draftApi from '../api/draft';
import type { DraftCommentDto, DraftReplyDto, PrReference, ReviewSessionDto } from '../api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

function emptySession(): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftComments: [],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
  };
}

function comment(id: string, body: string, opts: Partial<DraftCommentDto> = {}): DraftCommentDto {
  return {
    id,
    filePath: 'src/Foo.cs',
    lineNumber: 10,
    side: 'right',
    anchoredSha: 'a'.repeat(40),
    anchoredLineContent: '    return 0;',
    bodyMarkdown: body,
    status: 'draft',
    isOverriddenStale: false,
    postedCommentId: null,
    ...opts,
  };
}

function reply(id: string, body: string, opts: Partial<DraftReplyDto> = {}): DraftReplyDto {
  return {
    id,
    parentThreadId: 'PRRT_a',
    replyCommentId: null,
    bodyMarkdown: body,
    status: 'draft',
    isOverriddenStale: false,
    ...opts,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDraftSession — diff-and-prefer merge', () => {
  it('returns server verbatim on first fetch (no local state to merge against)', async () => {
    const initial = { ...emptySession(), draftComments: [comment('c1', 'first')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(initial);
    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.session).toEqual(initial);
  });

  it('DiffAndPreferMerge_KeepsLocalBody_WhenComposerOpen — composer-open ids preserve local body', async () => {
    const v1 = {
      ...emptySession(),
      draftComments: [comment('c1', 'local-body', { status: 'draft' })],
    };
    // Server version moved the draft to status: 'stale' AND changed the body.
    const v2 = {
      ...emptySession(),
      draftComments: [comment('c1', 'remote-body', { status: 'stale', isOverriddenStale: false })],
    };
    const spy = vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Simulate a composer being open for c1.
    let cleanup: () => void = () => undefined;
    act(() => {
      cleanup = result.current.registerOpenComposer('c1', 'files-tab');
    });

    await act(async () => {
      await result.current.refetch();
    });

    // Body stays local; status accepted from server.
    expect(result.current.session?.draftComments[0]).toMatchObject({
      id: 'c1',
      bodyMarkdown: 'local-body',
      status: 'stale',
      isOverriddenStale: false,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('DiffAndPreferMerge_AcceptsServer_WhenNoComposerOpen — server wins for unwatched ids', async () => {
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'local-body')] };
    const v2 = {
      ...emptySession(),
      draftComments: [comment('c1', 'remote-body', { status: 'moved' })],
    };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.session?.draftComments[0]).toMatchObject({
      id: 'c1',
      bodyMarkdown: 'remote-body',
      status: 'moved',
    });
  });

  it('DraftDeletedElsewhere_RemovesFromLocalList — local-only ids are dropped', async () => {
    const v1 = {
      ...emptySession(),
      draftComments: [comment('c1', 'first'), comment('c2', 'second')],
    };
    const v2 = { ...emptySession(), draftComments: [comment('c1', 'first')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.session?.draftComments.length).toBe(2));

    await act(async () => {
      await result.current.refetch();
    });

    const ids = result.current.session?.draftComments.map((d) => d.id);
    expect(ids).toEqual(['c1']);
  });

  it('OutOfBandUpdate_NoComposer_FiresToast — body change with no open composer surfaces toast', async () => {
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'local-body')] };
    const v2 = { ...emptySession(), draftComments: [comment('c1', 'remote-body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outOfBandToast).toBeNull();

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.outOfBandToast).toEqual({
      draftId: 'c1',
      filePath: 'src/Foo.cs',
    });
  });

  it('OutOfBandUpdate_OwnTab_NoToast — when refetch is suppressed (own-tab), no toast fires', async () => {
    // The subscriber filter at Task 39 prevents calling refetch for own-tab events.
    // This test confirms the hook produces no toast purely from initial mount.
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'local-body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(v1);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Simulate the SSE handler filtering own-tab → no refetch invoked.
    await act(async () => {
      // (intentionally no refetch())
      await Promise.resolve();
    });

    expect(result.current.outOfBandToast).toBeNull();
  });

  it('clearOutOfBandToast resets the toast state', async () => {
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'local-body')] };
    const v2 = { ...emptySession(), draftComments: [comment('c1', 'remote-body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.outOfBandToast).not.toBeNull();

    act(() => {
      result.current.clearOutOfBandToast();
    });
    expect(result.current.outOfBandToast).toBeNull();
  });
});

describe('useDraftSession — registerOpenComposer refcount', () => {
  it('two registrations for the same id keep the predicate truthy until both unmount', async () => {
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'local-body')] };
    const v2 = { ...emptySession(), draftComments: [comment('c1', 'remote-body')] };
    vi.spyOn(draftApi, 'getDraft')
      .mockResolvedValueOnce(v1)
      .mockResolvedValueOnce(v2)
      .mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let cleanupA: () => void = () => undefined;
    let cleanupB: () => void = () => undefined;
    act(() => {
      cleanupA = result.current.registerOpenComposer('c1', 'files-tab');
      cleanupB = result.current.registerOpenComposer('c1', 'drafts-tab');
    });

    // First refetch: both refs active → keep local body.
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.session?.draftComments[0].bodyMarkdown).toBe('local-body');

    // Drop one ref: predicate still truthy.
    act(() => {
      cleanupA();
    });
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.session?.draftComments[0].bodyMarkdown).toBe('local-body');

    cleanupB();
  });
});

describe('useDraftSession — replies merge mirrors comments', () => {
  it('reply with open composer keeps local body', async () => {
    const v1 = { ...emptySession(), draftReplies: [reply('r1', 'local')] };
    const v2 = { ...emptySession(), draftReplies: [reply('r1', 'remote', { status: 'stale' })] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let cleanup: () => void = () => undefined;
    act(() => {
      cleanup = result.current.registerOpenComposer('r1', 'files-tab');
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.session?.draftReplies[0]).toMatchObject({
      id: 'r1',
      bodyMarkdown: 'local',
      status: 'stale',
    });
    cleanup();
  });

  it('reply out-of-band update fires toast with filePath: null', async () => {
    const v1 = { ...emptySession(), draftReplies: [reply('r1', 'local')] };
    const v2 = { ...emptySession(), draftReplies: [reply('r1', 'remote')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.outOfBandToast).toEqual({ draftId: 'r1', filePath: null });
  });
});

describe('useDraftSession — error state', () => {
  it('sets status: error on initial fetch failure', async () => {
    vi.spyOn(draftApi, 'getDraft').mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toBe('network');
  });
});

describe('useDraftSession — registerOpenComposer ownerKey set semantics', () => {
  it('two distinct owners on the same draft: both must release before the draft is considered closed', async () => {
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'local-body')] };
    const v2 = { ...emptySession(), draftComments: [comment('c1', 'remote-body')] };
    vi.spyOn(draftApi, 'getDraft')
      .mockResolvedValueOnce(v1)
      .mockResolvedValueOnce(v2)
      .mockResolvedValueOnce(v2)
      .mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let cleanupFilesTab: () => void = () => undefined;
    let cleanupDraftsTab: () => void = () => undefined;
    act(() => {
      cleanupFilesTab = result.current.registerOpenComposer('c1', 'files-tab');
      cleanupDraftsTab = result.current.registerOpenComposer('c1', 'drafts-tab');
    });

    // Both open → predicate truthy → keeps local body.
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.session?.draftComments[0].bodyMarkdown).toBe('local-body');

    // Release files-tab → drafts-tab still holds → predicate still truthy.
    act(() => {
      cleanupFilesTab();
    });
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.session?.draftComments[0].bodyMarkdown).toBe('local-body');

    // Release drafts-tab → no holder → predicate falsy → server wins.
    act(() => {
      cleanupDraftsTab();
    });
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.session?.draftComments[0].bodyMarkdown).toBe('remote-body');
  });

  it('adding the same ownerKey twice is idempotent — single release closes the draft', async () => {
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'local-body')] };
    const v2 = { ...emptySession(), draftComments: [comment('c1', 'remote-body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let cleanupA: () => void = () => undefined;
    let cleanupB: () => void = () => undefined;
    act(() => {
      // Same ownerKey added twice — Set deduplicates.
      cleanupA = result.current.registerOpenComposer('c1', 'files-tab');
      cleanupB = result.current.registerOpenComposer('c1', 'files-tab');
    });

    // Call both cleanups — Set already removed the key on the first delete,
    // second is a no-op, draft treated as closed.
    act(() => {
      cleanupA();
      cleanupB();
    });
    await act(async () => {
      await result.current.refetch();
    });
    // Server wins since the draft is now considered closed.
    expect(result.current.session?.draftComments[0].bodyMarkdown).toBe('remote-body');
  });
});

describe('useDraftSession — refetch generation guard (#612 C)', () => {
  it('drops a stale refetch for the previous PR instead of clobbering the new PR session', async () => {
    const refA: PrReference = { owner: 'octocat', repo: 'hello', number: 1 };
    const refB: PrReference = { owner: 'octocat', repo: 'hello', number: 2 };
    const sessionA = { ...emptySession(), draftComments: [comment('a1', 'A-body')] };
    const sessionB = { ...emptySession(), draftComments: [comment('b1', 'B-body')] };

    // The imperative refetch for PR-A is held pending until after the switch to PR-B.
    let resolveRefetchA!: (v: ReviewSessionDto) => void;
    const refetchAPending = new Promise<ReviewSessionDto>((res) => {
      resolveRefetchA = res;
    });

    vi.spyOn(draftApi, 'getDraft')
      .mockResolvedValueOnce(sessionA) // 1: PR-A mount load
      .mockReturnValueOnce(refetchAPending) // 2: PR-A imperative refetch (still in flight)
      .mockResolvedValueOnce(sessionB); // 3: PR-B mount load after rerender

    const { result, rerender } = renderHook(({ r }) => useDraftSession(r), {
      initialProps: { r: refA },
    });
    await waitFor(() => expect(result.current.session?.draftComments[0]?.id).toBe('a1'));

    // Kick off a refetch for PR-A (e.g. an SSE subscriber / onReloadComplete); it stays pending.
    const refetchACall = result.current.refetch();

    // User switches to PR-B; its mount effect loads sessionB.
    rerender({ r: refB });
    await waitFor(() => expect(result.current.session?.draftComments[0]?.id).toBe('b1'));

    // The stale PR-A refetch finally resolves — its result must be discarded.
    await act(async () => {
      resolveRefetchA(sessionA);
      await refetchACall;
    });

    // PR-B's session survives; PR-A's late response did not overwrite it.
    expect(result.current.session?.draftComments).toHaveLength(1);
    expect(result.current.session?.draftComments[0]?.id).toBe('b1');
  });
});

describe('useDraftSession — getPrRootHolder', () => {
  function prRootComment(id: string, body: string): DraftCommentDto {
    return comment(id, body, {
      filePath: null,
      lineNumber: null,
      side: null,
      anchoredSha: null,
      anchoredLineContent: null,
    });
  }

  it('returns null when no PR-root draft exists in session', async () => {
    const v1 = { ...emptySession(), draftComments: [comment('c1', 'body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(v1);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.getPrRootHolder()).toBeNull();
  });

  it('returns null when a PR-root draft exists but no composer holds it', async () => {
    const v1 = { ...emptySession(), draftComments: [prRootComment('pr-root', 'body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(v1);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.getPrRootHolder()).toBeNull();
  });

  it('returns the ownerKey when a composer holds the PR-root draft', async () => {
    const v1 = { ...emptySession(), draftComments: [prRootComment('pr-root', 'body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(v1);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let cleanup: () => void = () => undefined;
    act(() => {
      cleanup = result.current.registerOpenComposer('pr-root', 'reply-composer');
    });

    expect(result.current.getPrRootHolder()).toBe('reply-composer');
    cleanup();
  });

  it('returns null after the composer releases the PR-root draft', async () => {
    const v1 = { ...emptySession(), draftComments: [prRootComment('pr-root', 'body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(v1);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let cleanup: () => void = () => undefined;
    act(() => {
      cleanup = result.current.registerOpenComposer('pr-root', 'reply-composer');
    });
    act(() => {
      cleanup();
    });

    expect(result.current.getPrRootHolder()).toBeNull();
  });

  it('returns insertion-order-first ownerKey when multiple holders exist', async () => {
    const v1 = { ...emptySession(), draftComments: [prRootComment('pr-root', 'body')] };
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(v1);

    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let cleanupA: () => void = () => undefined;
    let cleanupB: () => void = () => undefined;
    act(() => {
      cleanupA = result.current.registerOpenComposer('pr-root', 'reply-composer');
      cleanupB = result.current.registerOpenComposer('pr-root', 'submit-dialog');
    });

    // First inserted wins.
    expect(result.current.getPrRootHolder()).toBe('reply-composer');
    cleanupA();
    cleanupB();
  });
});

// #744 — optimistic local mutators so create/discard reflect instantly, without
// waiting on the trailing reconciliation refetch (see
// docs/specs/2026-07-05-drafts-lifecycle-optimistic-updates-design.md).
describe('useDraftSession — removeDraftLocally (optimistic discard)', () => {
  async function readyWith(session: ReviewSessionDto) {
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(session);
    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    return result;
  }

  it('splices a comment id out of draftComments', async () => {
    const result = await readyWith({
      ...emptySession(),
      draftComments: [comment('c1', 'one'), comment('c2', 'two')],
    });
    act(() => result.current.removeDraftLocally('c1'));
    expect(result.current.session?.draftComments.map((c) => c.id)).toEqual(['c2']);
    expect(result.current.session?.draftReplies).toEqual([]);
  });

  it('splices a reply id out of draftReplies', async () => {
    const result = await readyWith({
      ...emptySession(),
      draftReplies: [reply('r1', 'one'), reply('r2', 'two')],
    });
    act(() => result.current.removeDraftLocally('r2'));
    expect(result.current.session?.draftReplies.map((r) => r.id)).toEqual(['r1']);
  });

  it('is a no-op when the id is absent (leaves the session unchanged)', async () => {
    const before = { ...emptySession(), draftComments: [comment('c1', 'one')] };
    const result = await readyWith(before);
    act(() => result.current.removeDraftLocally('nope'));
    expect(result.current.session?.draftComments.map((c) => c.id)).toEqual(['c1']);
  });

  it('is idempotent — removing the same id twice leaves one clean removal', async () => {
    const result = await readyWith({
      ...emptySession(),
      draftComments: [comment('c1', 'one'), comment('c2', 'two')],
    });
    act(() => {
      result.current.removeDraftLocally('c1');
      result.current.removeDraftLocally('c1');
    });
    expect(result.current.session?.draftComments.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('useDraftSession — insertDraftLocally (optimistic create)', () => {
  async function readyWith(session: ReviewSessionDto) {
    vi.spyOn(draftApi, 'getDraft').mockResolvedValue(session);
    const { result } = renderHook(() => useDraftSession(ref));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    return result;
  }

  it('appends a new comment draft to draftComments', async () => {
    const result = await readyWith(emptySession());
    const c = comment('c1', 'new draft');
    act(() => result.current.insertDraftLocally(c));
    expect(result.current.session?.draftComments).toEqual([c]);
    expect(result.current.session?.draftReplies).toEqual([]);
  });

  it('routes a reply DTO (has parentThreadId) into draftReplies', async () => {
    const result = await readyWith(emptySession());
    const r = reply('r1', 'new reply');
    act(() => result.current.insertDraftLocally(r));
    expect(result.current.session?.draftReplies).toEqual([r]);
    expect(result.current.session?.draftComments).toEqual([]);
  });

  it('dedups by id — inserting an existing id replaces rather than duplicates', async () => {
    const result = await readyWith({
      ...emptySession(),
      draftComments: [comment('c1', 'old body')],
    });
    act(() => result.current.insertDraftLocally(comment('c1', 'new body')));
    expect(result.current.session?.draftComments).toHaveLength(1);
    expect(result.current.session?.draftComments[0].bodyMarkdown).toBe('new body');
  });
});
