import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useComposerAutoSave,
  COMPOSER_DEBOUNCE_MS,
  type ComposerAnchor,
  type UseComposerAutoSaveProps,
} from '../src/hooks/useComposerAutoSave';
import * as draftApi from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const inlineAnchor: ComposerAnchor = {
  kind: 'inline-comment',
  filePath: 'src/Foo.cs',
  lineNumber: 42,
  side: 'right',
  anchoredSha: 'a'.repeat(40),
  anchoredLineContent: '    return 0;',
};

const replyAnchor: ComposerAnchor = {
  kind: 'reply',
  parentThreadId: 'PRRT_kwDOCRphzc6S',
};

function defaultProps(overrides: Partial<UseComposerAutoSaveProps> = {}): UseComposerAutoSaveProps {
  return {
    prRef: ref,
    prState: 'open',
    body: '',
    draftId: null,
    anchor: inlineAnchor,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushTimersAndPromises(ms: number = COMPOSER_DEBOUNCE_MS) {
  // Advancing fake timers triggers timer callbacks but doesn't drain the
  // microtask queue. We need both — a save callback awaits a promise,
  // and async assertions need the chain to settle.
  await act(async () => {
    vi.advanceTimersByTime(ms);
    // Run pending microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useComposerAutoSave — threshold gating (no draftId)', () => {
  it('EmptyComposer_NoPut_NoDraftCreated', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() => useComposerAutoSave(defaultProps({ body: '' })));
    await flushTimersAndPromises();
    expect(spy).not.toHaveBeenCalled();
  });

  it('BodyBelow3Chars_NoPut_NoDraftCreated — "ab" (length 2) is sub-threshold', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'ab' })));
    await flushTimersAndPromises();
    expect(spy).not.toHaveBeenCalled();
  });

  it('BodyAt3Chars_FiresNewDraftComment — "abc" (length 3) crosses threshold', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-1' });
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'abc' })));
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({
      kind: 'newDraftComment',
      payload: expect.objectContaining({ bodyMarkdown: 'abc', filePath: 'src/Foo.cs' }),
    });
  });

  it('threshold uses trim() — "  ab  " (whitespace) stays sub-threshold', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() => useComposerAutoSave(defaultProps({ body: '  ab  ' })));
    await flushTimersAndPromises();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useComposerAutoSave — debounce', () => {
  it('Debounce_250ms_BatchesKeystrokes — 5 keystrokes inside the window produce one PUT', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-1' });
    const { rerender } = renderHook(
      ({ body }: { body: string }) => useComposerAutoSave(defaultProps({ body })),
      { initialProps: { body: 'abc' } },
    );

    // Fire keystrokes inside the debounce window.
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    rerender({ body: 'abcd' });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    rerender({ body: 'abcde' });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    rerender({ body: 'abcdef' });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    rerender({ body: 'abcdefg' });

    // No PUT yet (debounce window not elapsed since last keystroke).
    expect(spy).not.toHaveBeenCalled();

    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    // The single PUT carries the LAST keystroke's body.
    expect(spy.mock.calls[0][1]).toMatchObject({
      kind: 'newDraftComment',
      payload: expect.objectContaining({ bodyMarkdown: 'abcdefg' }),
    });
  });
});

describe('useComposerAutoSave — assignedId + update path', () => {
  it('AfterAssignedId_SubsequentKeystrokesUseUpdateDraftComment', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValueOnce({ ok: true, assignedId: 'uuid-1' })
      .mockResolvedValueOnce({ ok: true, assignedId: null });
    const onAssignedId = vi.fn();

    const { rerender } = renderHook(
      ({ body, draftId }: { body: string; draftId: string | null }) =>
        useComposerAutoSave(defaultProps({ body, draftId, onAssignedId })),
      { initialProps: { body: 'abc', draftId: null as string | null } },
    );

    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onAssignedId).toHaveBeenCalledWith('uuid-1');

    // Parent ack: passes draftId in via props for the next render cycle.
    rerender({ body: 'abcd', draftId: 'uuid-1' });
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toEqual({
      kind: 'updateDraftComment',
      payload: { id: 'uuid-1', bodyMarkdown: 'abcd' },
    });
  });

  it('InFlightCreate_QueuesSubsequentDebounce_NoDuplicateCreate', async () => {
    // Hold the first create open. While it's pending, type more text and let
    // the second debounce fire. The hook must NOT issue a second create PUT.
    let resolveFirst: (v: { ok: true; assignedId: string }) => void = () => undefined;
    const firstPending = new Promise<{ ok: true; assignedId: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce({ ok: true, assignedId: null });

    const { rerender } = renderHook(
      ({ body }: { body: string }) => useComposerAutoSave(defaultProps({ body })),
      { initialProps: { body: 'abc' } },
    );

    // First debounce → fires create (in flight).
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'newDraftComment' });

    // While in flight, user types more. Second debounce should await the
    // pending create, NOT fire a duplicate.
    rerender({ body: 'abcd' });
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1); // still 1

    // Resolve the create. Now the queued debounce can complete by issuing
    // an update with the assigned id.
    await act(async () => {
      resolveFirst({ ok: true, assignedId: 'uuid-q' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toEqual({
      kind: 'updateDraftComment',
      payload: { id: 'uuid-q', bodyMarkdown: 'abcd' },
    });
  });

  it('OneOrTwoChars_WithDraftId_FiresUpdate — threshold gate is for creation only', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() =>
      useComposerAutoSave(defaultProps({ body: 'ab', draftId: 'uuid-existing' })),
    );
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({
      kind: 'updateDraftComment',
      payload: { id: 'uuid-existing', bodyMarkdown: 'ab' },
    });
  });

  it('EmptyBody_WithDraftId_FiresDeletePatch_AndSignalsLocalDelete', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const onLocalDelete = vi.fn();
    renderHook(() =>
      useComposerAutoSave(
        defaultProps({ body: '', draftId: 'uuid-existing', onLocalDelete }),
      ),
    );
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({
      kind: 'deleteDraftComment',
      payload: { id: 'uuid-existing' },
    });
    expect(onLocalDelete).toHaveBeenCalledOnce();
  });
});

describe('useComposerAutoSave — error handling', () => {
  it('Update404_TriggersDraftDeletedRecoveryCallback', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 404,
      kind: 'draft-not-found',
      body: { error: 'draft-not-found' },
    });
    const onDraftDeletedByServer = vi.fn();
    const { result } = renderHook(() =>
      useComposerAutoSave(
        defaultProps({
          body: 'abcd',
          draftId: 'uuid-existing',
          onDraftDeletedByServer,
        }),
      ),
    );
    await flushTimersAndPromises();
    expect(onDraftDeletedByServer).toHaveBeenCalledOnce();
    expect(result.current.badge).toBe('unsaved');
  });

  it('Network5xx_KeepsLocalBody_MarksUnsaved_RetriesOnNextKeystroke', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        kind: 'other',
        body: { error: 'boom' },
      })
      .mockResolvedValueOnce({ ok: true, assignedId: 'uuid-retry' });
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useComposerAutoSave(defaultProps({ body })),
      { initialProps: { body: 'abc' } },
    );

    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.badge).toBe('unsaved');

    // Next keystroke → retry.
    rerender({ body: 'abcd' });
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.badge).toBe('saved');
  });

  it('Body422_SurfacesRejectedBadge_NoRetry', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 422,
      kind: 'invalid-body',
      body: { error: 'body-too-large' },
    });
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useComposerAutoSave(defaultProps({ body })),
      { initialProps: { body: 'abc' } },
    );

    await flushTimersAndPromises();
    expect(result.current.badge).toBe('rejected');
    expect(spy).toHaveBeenCalledTimes(1);

    // The next keystroke DOES still attempt a PUT — "no retry" means the
    // hook doesn't auto-retry the same failed body, but a new keystroke
    // (different body) triggers a new save attempt. The 'rejected' badge
    // remains until the new attempt succeeds or fails.
    rerender({ body: 'abcd' });
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('useComposerAutoSave — prState gate', () => {
  it('prState_Closed_NoSave', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'abc', prState: 'closed' })));
    await flushTimersAndPromises();
    expect(spy).not.toHaveBeenCalled();
  });

  it('prState_Merged_NoSave', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'abc', prState: 'merged' })));
    await flushTimersAndPromises();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useComposerAutoSave — flush()', () => {
  it('flush_ImmediatelyFiresPendingSave_BypassingDebounce', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-1' });
    const { result } = renderHook(() => useComposerAutoSave(defaultProps({ body: 'abc' })));

    // Don't advance timers — call flush directly.
    await act(async () => {
      await result.current.flush();
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'newDraftComment' });
  });
});

describe('useComposerAutoSave — reply anchor variant', () => {
  it('reply anchor fires newDraftReply on create', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-r' });
    renderHook(() =>
      useComposerAutoSave(defaultProps({ body: 'abc', anchor: replyAnchor })),
    );
    await flushTimersAndPromises();
    expect(spy.mock.calls[0][1]).toEqual({
      kind: 'newDraftReply',
      payload: { parentThreadId: 'PRRT_kwDOCRphzc6S', bodyMarkdown: 'abc' },
    });
  });

  it('reply anchor fires updateDraftReply on existing draft', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() =>
      useComposerAutoSave(
        defaultProps({ body: 'abc edited', draftId: 'uuid-r', anchor: replyAnchor }),
      ),
    );
    await flushTimersAndPromises();
    expect(spy.mock.calls[0][1]).toEqual({
      kind: 'updateDraftReply',
      payload: { id: 'uuid-r', bodyMarkdown: 'abc edited' },
    });
  });

  it('reply anchor empty body fires deleteDraftReply', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() =>
      useComposerAutoSave(defaultProps({ body: '', draftId: 'uuid-r', anchor: replyAnchor })),
    );
    await flushTimersAndPromises();
    expect(spy.mock.calls[0][1]).toEqual({
      kind: 'deleteDraftReply',
      payload: { id: 'uuid-r' },
    });
  });
});

describe('useComposerAutoSave — pr-root anchor variant', () => {
  it('pr-root anchor fires newPrRootDraftComment on create', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-pr' });
    renderHook(() =>
      useComposerAutoSave(defaultProps({ body: 'pr level remark', anchor: { kind: 'pr-root' } })),
    );
    await flushTimersAndPromises();
    expect(spy.mock.calls[0][1]).toEqual({
      kind: 'newPrRootDraftComment',
      payload: { bodyMarkdown: 'pr level remark' },
    });
  });
});
