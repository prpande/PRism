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
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'ab', draftId: 'uuid-existing' })));
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
      useComposerAutoSave(defaultProps({ body: '', draftId: 'uuid-existing', onLocalDelete })),
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

describe('useComposerAutoSave — prState gate (#302: relaxed)', () => {
  // #302: guard relaxed — drafts now stage on closed/merged PRs so post-now works.
  it('prState_Closed_SavesNormally', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-closed' });
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'abc', prState: 'closed' })));
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'newDraftComment' });
  });

  it('prState_Merged_SavesNormally', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-merged' });
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'abc', prState: 'merged' })));
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'newDraftComment' });
  });

  // The disabled flag (cross-tab take-over) STILL blocks saves regardless of prState.
  it('disabled_flag_BlocksSave_regardless_of_prState', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderHook(() =>
      useComposerAutoSave(defaultProps({ body: 'abc', prState: 'open', disabled: true })),
    );
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

  // #302 — flush on merged PR must stage the draft and return its id.
  it('flush_OnMergedPR_StagesDraftAndReturnsId', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-merged' });
    const { result } = renderHook(() =>
      useComposerAutoSave(defaultProps({ body: 'abc', prState: 'merged' })),
    );

    let returnedId: string | null = null;
    await act(async () => {
      returnedId = await result.current.flush();
    });

    // Draft must have been staged
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'newDraftComment' });
    // flush must return the assigned id (not null)
    expect(returnedId).toBe('uuid-merged');
  });
});

describe('useComposerAutoSave — reply anchor variant', () => {
  it('reply anchor fires newDraftReply on create', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-r' });
    renderHook(() => useComposerAutoSave(defaultProps({ body: 'abc', anchor: replyAnchor })));
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

// A deferred promise whose resolution we drive manually, to hold a save
// in-flight while we mutate props (#602 Defects B and C).
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Drains microtasks without advancing timers — used after an unmount or a
// manual promise resolution that kicks off an async save chain.
async function drainMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useComposerAutoSave — flush on unmount (#602 Defect A)', () => {
  it('UnmountWithPendingDebounce_FlushesLastKeystroke', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-1' });
    const { unmount } = renderHook(() => useComposerAutoSave(defaultProps({ body: 'abcd' })));

    // Timer pending but debounce window not elapsed → no save yet.
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(spy).not.toHaveBeenCalled();

    // Unmount before the 250 ms debounce fires. The pending edit must still persist.
    unmount();
    await drainMicrotasks();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({
      kind: 'newDraftComment',
      payload: expect.objectContaining({ bodyMarkdown: 'abcd' }),
    });
  });

  it('UnmountSubThreshold_NoFlush — empty/short composer never creates a stray draft', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const { unmount } = renderHook(() => useComposerAutoSave(defaultProps({ body: 'ab' })));

    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    unmount();
    await drainMicrotasks();

    expect(spy).not.toHaveBeenCalled();
  });

  it('UnmountWhenDisabled_NoFlush — taken-over tab does not write on unmount', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const { unmount } = renderHook(() =>
      useComposerAutoSave(defaultProps({ body: 'abcd', disabled: true })),
    );

    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    unmount();
    await drainMicrotasks();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useComposerAutoSave — post-await disabled re-check (#602 Defect B)', () => {
  it('DisabledFlipsDuringCreate_NoNotify_NoIdRetained', async () => {
    const create = deferred<{ ok: true; assignedId: string }>();
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockImplementationOnce(() => create.promise)
      .mockResolvedValue({ ok: true, assignedId: 'uuid-2' });
    const onAssignedId = vi.fn();

    const { result, rerender } = renderHook(
      ({ body, disabled }: { body: string; disabled: boolean }) =>
        useComposerAutoSave(defaultProps({ body, disabled, onAssignedId })),
      { initialProps: { body: 'abc', disabled: false } },
    );

    await flushTimersAndPromises(); // create fired, held in-flight
    expect(spy).toHaveBeenCalledTimes(1);

    // Cross-tab take-over flips disabled while the PUT is in flight.
    rerender({ body: 'abc', disabled: true });
    await act(async () => {
      create.resolve({ ok: true, assignedId: 'uuid-1' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // §5.7a: no notification fired, badge did not advance to 'saved'.
    expect(onAssignedId).not.toHaveBeenCalled();
    expect(result.current.badge).not.toBe('saved');

    // The local id must NOT have been retained: re-enabling and editing fires a
    // fresh CREATE, not an update against the suppressed assigned id.
    rerender({ body: 'abcde', disabled: false });
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toMatchObject({ kind: 'newDraftComment' });
  });

  it('DisabledFlipsDuringUpdate_NoOnSaved', async () => {
    const update = deferred<{ ok: true; assignedId: null }>();
    const spy = vi.spyOn(draftApi, 'sendPatch').mockImplementationOnce(() => update.promise);
    const onSaved = vi.fn();

    const { result, rerender } = renderHook(
      ({ body, disabled }: { body: string; disabled: boolean }) =>
        useComposerAutoSave(defaultProps({ body, disabled, draftId: 'uuid-x', onSaved })),
      { initialProps: { body: 'abcd', disabled: false } },
    );

    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'updateDraftComment' });

    rerender({ body: 'abcd', disabled: true });
    await act(async () => {
      update.resolve({ ok: true, assignedId: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.badge).not.toBe('saved');
  });

  it('DisabledFlipsDuringDelete_NoOnLocalDelete', async () => {
    const del = deferred<{ ok: true; assignedId: null }>();
    const spy = vi.spyOn(draftApi, 'sendPatch').mockImplementationOnce(() => del.promise);
    const onLocalDelete = vi.fn();

    const { rerender } = renderHook(
      ({ body, disabled }: { body: string; disabled: boolean }) =>
        useComposerAutoSave(defaultProps({ body, disabled, draftId: 'uuid-x', onLocalDelete })),
      { initialProps: { body: '', disabled: false } },
    );

    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'deleteDraftComment' });

    rerender({ body: '', disabled: true });
    await act(async () => {
      del.resolve({ ok: true, assignedId: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLocalDelete).not.toHaveBeenCalled();
  });

  // Regression guard for the §5.7a flush-path guarantee (ce-doc-review security
  // finding): a flush() invoked on a taken-over tab performs no write.
  it('FlushWhenDisabled_NoWrite_ReturnsNull', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const { result } = renderHook(() =>
      useComposerAutoSave(defaultProps({ body: 'abc', disabled: true })),
    );

    let returned: string | null = 'sentinel';
    await act(async () => {
      returned = await result.current.flush();
    });

    expect(spy).not.toHaveBeenCalled();
    expect(returned).toBeNull();
  });

  // §5.7a leak guard: a draft is created (id assigned), THEN a cross-tab
  // take-over flips disabled. A flush() on the now-read-only tab must not hand
  // the previously-assigned id back to the caller — it returns null, exactly as
  // if no write had occurred. (Preflight adversarial finding.)
  it('FlushAfterCreateThenDisabled_ReturnsNull_NoForeignId', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-1' });

    const { result, rerender } = renderHook(
      ({ body, disabled }: { body: string; disabled: boolean }) =>
        useComposerAutoSave(defaultProps({ body, disabled })),
      { initialProps: { body: 'abc', disabled: false } },
    );

    // Create completes; the hook now holds the assigned id internally.
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);

    // Cross-tab take-over flips this tab read-only.
    rerender({ body: 'abc', disabled: true });

    let returned: string | null = 'sentinel';
    await act(async () => {
      returned = await result.current.flush();
    });

    // No second write, and no foreign id handed back to the caller.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(returned).toBeNull();
  });
});

describe('useComposerAutoSave — serialized saves (#602 Defect C)', () => {
  it('OverlappingUpdateThenDelete_ResolveInOrder_SecondWaitsForFirst', async () => {
    const update = deferred<{ ok: true; assignedId: null }>();
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockImplementationOnce(() => update.promise) // update (held in-flight)
      .mockResolvedValue({ ok: true, assignedId: null }); // delete

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) =>
        useComposerAutoSave(defaultProps({ body, draftId: 'uuid-x' })),
      { initialProps: { body: 'abcd' } },
    );

    // First save: update, fired via debounce, now held in-flight.
    await flushTimersAndPromises();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ kind: 'updateDraftComment' });

    // User clears the body then flushes → a delete, while the update is still in flight.
    rerender({ body: '' });
    act(() => {
      void result.current.flush();
    });

    // Serialization: the delete must NOT dispatch until the update resolves.
    await drainMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);

    // Resolve the update → the queued delete now dispatches, in order.
    await act(async () => {
      update.resolve({ ok: true, assignedId: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toMatchObject({ kind: 'deleteDraftComment' });
  });
});
