import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWholeFileFailureLatch } from './useWholeFileFailureLatch';

type FetchStatus = 'idle' | 'loading' | 'ok' | 'failed';

interface HookOpts {
  fetchStatus: FetchStatus;
  failureReason: string | null | undefined;
  selectedPath: string | null;
  onWholeFileFailed?: (reason: string) => void;
  onWholeFileRetry?: () => void;
}

function renderLatch(initial: HookOpts) {
  return renderHook((opts: HookOpts) => useWholeFileFailureLatch(opts), {
    initialProps: initial,
  });
}

describe('useWholeFileFailureLatch', () => {
  it('latches on the idle→failed transition and fires onWholeFileFailed exactly once', () => {
    const onWholeFileFailed = vi.fn();
    const { result, rerender } = renderLatch({
      fetchStatus: 'idle',
      failureReason: null,
      selectedPath: 'a.ts',
      onWholeFileFailed,
    });
    expect(result.current.failure).toBeNull();

    rerender({
      fetchStatus: 'failed',
      failureReason: 'too large',
      selectedPath: 'a.ts',
      onWholeFileFailed,
    });
    expect(result.current.failure).toBe('too large');
    expect(onWholeFileFailed).toHaveBeenCalledTimes(1);
    expect(onWholeFileFailed).toHaveBeenCalledWith('too large');
  });

  it('does NOT re-fire the callback while staying failed across rerenders (fire-once latch)', () => {
    const onWholeFileFailed = vi.fn();
    const props: HookOpts = {
      fetchStatus: 'failed',
      failureReason: 'too large',
      selectedPath: 'a.ts',
      onWholeFileFailed,
    };
    const { result, rerender } = renderLatch({ ...props, fetchStatus: 'idle', failureReason: null });
    rerender(props);
    expect(onWholeFileFailed).toHaveBeenCalledTimes(1);

    rerender({ ...props });
    rerender({ ...props });
    expect(onWholeFileFailed).toHaveBeenCalledTimes(1);
    expect(result.current.failure).toBe('too large');
  });

  it('clears the latch when selectedPath changes', () => {
    const { result, rerender } = renderLatch({
      fetchStatus: 'idle',
      failureReason: null,
      selectedPath: 'a.ts',
    });
    rerender({ fetchStatus: 'failed', failureReason: 'too large', selectedPath: 'a.ts' });
    expect(result.current.failure).toBe('too large');

    rerender({ fetchStatus: 'failed', failureReason: 'too large', selectedPath: 'b.ts' });
    expect(result.current.failure).toBeNull();
  });

  it('does NOT clear a failure that lands on the initial mount (initial-mount skip)', () => {
    const { result } = renderLatch({
      fetchStatus: 'failed',
      failureReason: 'too large',
      selectedPath: 'a.ts',
    });
    expect(result.current.failure).toBe('too large');
  });

  it('dismiss() clears the latch without calling onWholeFileFailed again', () => {
    const onWholeFileFailed = vi.fn();
    const { result, rerender } = renderLatch({
      fetchStatus: 'idle',
      failureReason: null,
      selectedPath: 'a.ts',
      onWholeFileFailed,
    });
    rerender({
      fetchStatus: 'failed',
      failureReason: 'too large',
      selectedPath: 'a.ts',
      onWholeFileFailed,
    });
    expect(result.current.failure).toBe('too large');

    act(() => result.current.dismiss());
    expect(result.current.failure).toBeNull();
    expect(onWholeFileFailed).toHaveBeenCalledTimes(1);
  });

  it('retry is undefined without onWholeFileRetry', () => {
    const { result } = renderLatch({
      fetchStatus: 'failed',
      failureReason: 'too large',
      selectedPath: 'a.ts',
    });
    expect(result.current.retry).toBeUndefined();
  });

  it('retry clears the latch AND calls onWholeFileRetry', () => {
    const onWholeFileRetry = vi.fn();
    const { result } = renderLatch({
      fetchStatus: 'failed',
      failureReason: 'too large',
      selectedPath: 'a.ts',
      onWholeFileRetry,
    });
    expect(result.current.failure).toBe('too large');
    expect(result.current.retry).toBeDefined();

    act(() => result.current.retry?.());
    expect(result.current.failure).toBeNull();
    expect(onWholeFileRetry).toHaveBeenCalledTimes(1);
  });

  it('re-latches on a re-failure after retry', () => {
    const onWholeFileFailed = vi.fn();
    const onWholeFileRetry = vi.fn();
    const props: HookOpts = {
      fetchStatus: 'failed',
      failureReason: 'too large',
      selectedPath: 'a.ts',
      onWholeFileFailed,
      onWholeFileRetry,
    };
    const { result, rerender } = renderLatch(props);
    expect(result.current.failure).toBe('too large');

    act(() => result.current.retry?.());
    expect(result.current.failure).toBeNull();

    // Retry re-fires the fetch: failed → loading → failed re-latches.
    rerender({ ...props, fetchStatus: 'loading', failureReason: null });
    expect(result.current.failure).toBeNull();
    rerender({ ...props, fetchStatus: 'failed', failureReason: 'still too large' });
    expect(result.current.failure).toBe('still too large');
    expect(onWholeFileFailed).toHaveBeenCalledTimes(2);
  });
});
