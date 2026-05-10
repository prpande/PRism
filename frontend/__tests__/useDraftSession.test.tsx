import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDraftSession } from '../src/hooks/useDraftSession';
import * as draftApi from '../src/api/draft';
import type {
  DraftCommentDto,
  DraftReplyDto,
  PrReference,
  ReviewSessionDto,
} from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

function emptySession(): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftSummaryMarkdown: null,
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
      cleanup = result.current.registerOpenComposer('c1');
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
      cleanupA = result.current.registerOpenComposer('c1');
      cleanupB = result.current.registerOpenComposer('c1');
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
      cleanup = result.current.registerOpenComposer('r1');
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
