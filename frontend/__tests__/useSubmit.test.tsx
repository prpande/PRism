import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubmit } from '../src/hooks/useSubmit';
import type { PrReference } from '../src/api/types';

// --- SSE stream fake (matches the real EventStreamHandle.on contract: returns
//     an unsubscribe fn; useEventSource() takes no args). ---
type Listener = (data: unknown) => void;
let listeners: Map<string, Set<Listener>>;
function emit(type: string, data: unknown) {
  listeners.get(type)?.forEach((l) => l(data));
}
const fakeStream = {
  subscriberId: () => Promise.resolve('sub-1'),
  reconnectSignal: () => new AbortController().signal,
  on(type: string, cb: Listener) {
    const set = listeners.get(type) ?? new Set<Listener>();
    listeners.set(type, set);
    set.add(cb);
    return () => set.delete(cb);
  },
  close() {},
};

vi.mock('../src/hooks/useEventSource', () => ({
  useEventSource: () => fakeStream,
}));

const submitReviewMock = vi.fn();
const resumeForeignMock = vi.fn();
const discardForeignMock = vi.fn();

vi.mock('../src/api/submit', () => ({
  submitReview: (...a: unknown[]) => submitReviewMock(...a),
  resumeForeignPendingReview: (...a: unknown[]) => resumeForeignMock(...a),
  discardForeignPendingReview: (...a: unknown[]) => discardForeignMock(...a),
  SubmitConflictError: class SubmitConflictError extends Error {
    code = 'submit-in-progress';
  },
}));

const ref: PrReference = { owner: 'o', repo: 'r', number: 1 };
const PR_REF = 'o/r/1';

beforeEach(() => {
  listeners = new Map();
  submitReviewMock.mockReset().mockResolvedValue({ outcome: 'started' });
  resumeForeignMock.mockReset().mockResolvedValue(undefined);
  discardForeignMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSubmit', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useSubmit(ref));
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('submit() transitions idle → in-flight after the POST resolves', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Comment');
    });
    expect(result.current.state).toEqual({ kind: 'in-flight', steps: [] });
    expect(submitReviewMock).toHaveBeenCalledWith(ref, 'Comment');
  });

  it('submit() that throws returns the hook to idle and rethrows', async () => {
    const err = Object.assign(new Error('busy'), { code: 'submit-in-progress' });
    submitReviewMock.mockRejectedValueOnce(err);
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await expect(result.current.submit('Comment')).rejects.toThrow('busy');
    });
    expect(result.current.state.kind).toBe('idle');
  });

  it('submit-progress events upsert the steps array (advance + replace by step)', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Comment');
    });
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'BeginPendingReview',
        status: 'Started',
        done: 0,
        total: 1,
        errorMessage: null,
      }),
    );
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'BeginPendingReview',
        status: 'Succeeded',
        done: 1,
        total: 1,
        errorMessage: null,
      }),
    );
    const s = result.current.state;
    if (s.kind !== 'in-flight') throw new Error(`expected in-flight, got ${s.kind}`);
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ step: 'BeginPendingReview', status: 'Succeeded' });
  });

  it('Finalize Succeeded transitions to success', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Approve');
    });
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'Finalize',
        status: 'Succeeded',
        done: 1,
        total: 1,
        errorMessage: null,
      }),
    );
    expect(result.current.state.kind).toBe('success');
  });

  it('a Failed step transitions to failed and captures the error message', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Approve');
    });
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'AttachThreads',
        status: 'Failed',
        done: 1,
        total: 3,
        errorMessage: 'boom',
      }),
    );
    const s = result.current.state;
    if (s.kind !== 'failed') throw new Error(`expected failed, got ${s.kind}`);
    expect(s.failedStep).toBe('AttachThreads');
    expect(s.errorMessage).toBe('boom');
  });

  it('submit-foreign-pending-review transitions to foreign-pending-review-prompt with the snapshot', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Comment');
    });
    const snapshot = {
      prRef: PR_REF,
      pullRequestReviewId: 'PRR_x',
      commitOid: 'abc',
      createdAt: '2026-05-11T10:00:00Z',
      threadCount: 2,
      replyCount: 1,
    };
    act(() => emit('submit-foreign-pending-review', snapshot));
    const s = result.current.state;
    if (s.kind !== 'foreign-pending-review-prompt') throw new Error(`got ${s.kind}`);
    expect(s.snapshot).toEqual(snapshot);
  });

  it('submit-stale-commit-oid transitions to stale-commit-oid', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Comment');
    });
    act(() => emit('submit-stale-commit-oid', { prRef: PR_REF, orphanCommitOid: 'stale' }));
    expect(result.current.state).toEqual({ kind: 'stale-commit-oid', orphanCommitOid: 'stale' });
  });

  it('retry() re-fires the POST with the last-confirmed verdict', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('RequestChanges');
    });
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'AttachThreads',
        status: 'Failed',
        done: 0,
        total: 1,
        errorMessage: 'x',
      }),
    );
    submitReviewMock.mockClear();
    await act(async () => {
      await result.current.retry();
    });
    expect(submitReviewMock).toHaveBeenCalledWith(ref, 'RequestChanges');
    // retry carries the prior failed-run steps forward (so the dialog re-enters
    // Phase B immediately instead of flashing the "checking…" row).
    const s = result.current.state;
    if (s.kind !== 'in-flight') throw new Error(`expected in-flight, got ${s.kind}`);
    expect(s.steps).toEqual([
      { step: 'AttachThreads', status: 'Failed', done: 0, total: 1, errorMessage: 'x' },
    ]);
  });

  it('retry from failed past Phase A keeps BeginPendingReview ✓ in the carried steps', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Comment');
    });
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'BeginPendingReview',
        status: 'Succeeded',
        done: 1,
        total: 1,
        errorMessage: null,
      }),
    );
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'AttachThreads',
        status: 'Failed',
        done: 1,
        total: 3,
        errorMessage: 'blip',
      }),
    );
    await act(async () => {
      await result.current.retry();
    });
    const s = result.current.state;
    if (s.kind !== 'in-flight') throw new Error(`expected in-flight, got ${s.kind}`);
    expect(s.steps.some((x) => x.step === 'BeginPendingReview' && x.status === 'Succeeded')).toBe(
      true,
    );
  });

  it('a Finalize:Succeeded SSE arriving before the submit POST resolves still lands in success', async () => {
    let resolvePost: (v: unknown) => void = () => {};
    submitReviewMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePost = resolve)),
    );
    const { result } = renderHook(() => useSubmit(ref));
    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = result.current.submit('Comment');
    });
    // POST still pending; the fire-and-forget pipeline finishes and fans out.
    expect(result.current.state.kind).toBe('in-flight');
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'Finalize',
        status: 'Succeeded',
        done: 1,
        total: 1,
        errorMessage: null,
      }),
    );
    expect(result.current.state.kind).toBe('success');
    // Now the POST resolves — it must NOT clobber the success state.
    await act(async () => {
      resolvePost({ outcome: 'started' });
      await submitPromise;
    });
    expect(result.current.state.kind).toBe('success');
  });

  it('ignores events for a different prRef', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Comment');
    });
    act(() =>
      emit('submit-progress', {
        prRef: 'other/repo/9',
        step: 'BeginPendingReview',
        status: 'Started',
        done: 0,
        total: 1,
        errorMessage: null,
      }),
    );
    expect(result.current.state).toEqual({ kind: 'in-flight', steps: [] });
  });

  it('multi-tab guard: ignores SSE events when this tab has not initiated a submit', () => {
    const { result } = renderHook(() => useSubmit(ref));
    // A foreign tab fires the same prRef-scoped event; this tab never called submit().
    act(() =>
      emit('submit-progress', {
        prRef: PR_REF,
        step: 'BeginPendingReview',
        status: 'Started',
        done: 0,
        total: 1,
        errorMessage: null,
      }),
    );
    act(() => emit('submit-stale-commit-oid', { prRef: PR_REF, orphanCommitOid: 'x' }));
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('reset() returns to idle', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.submit('Comment');
    });
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('resumeForeignPendingReview calls the API and returns to idle', async () => {
    const { result } = renderHook(() => useSubmit(ref));
    await act(async () => {
      await result.current.resumeForeignPendingReview('PRR_x');
    });
    expect(resumeForeignMock).toHaveBeenCalledWith(ref, 'PRR_x');
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('unsubscribes its SSE listeners on unmount', async () => {
    const { unmount } = renderHook(() => useSubmit(ref));
    await waitFor(() => expect(listeners.get('submit-progress')?.size).toBe(1));
    unmount();
    expect(listeners.get('submit-progress')?.size ?? 0).toBe(0);
  });
});
