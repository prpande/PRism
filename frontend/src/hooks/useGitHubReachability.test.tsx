import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGitHubReachability, STALE_FAILING_AFTER_MS } from './useGitHubReachability';

describe('useGitHubReachability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stale:false → never failing', () => {
    const { result } = renderHook(() => useGitHubReachability(false));
    expect(result.current.failing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STALE_FAILING_AFTER_MS + 1000);
    });
    expect(result.current.failing).toBe(false);
  });

  it('stale:true but < 30s → not yet failing', () => {
    const { result } = renderHook(() => useGitHubReachability(true));
    expect(result.current.failing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STALE_FAILING_AFTER_MS - 1);
    });
    expect(result.current.failing).toBe(false);
  });

  it('stale:true past 30s → failing', () => {
    const { result } = renderHook(() => useGitHubReachability(true));
    act(() => {
      vi.advanceTimersByTime(STALE_FAILING_AFTER_MS + 1);
    });
    expect(result.current.failing).toBe(true);
  });

  it('stale:true then false before 30s → stays false (timer cancelled)', () => {
    const { result, rerender } = renderHook(({ stale }) => useGitHubReachability(stale), {
      initialProps: { stale: true },
    });
    act(() => {
      vi.advanceTimersByTime(STALE_FAILING_AFTER_MS / 2);
    });
    rerender({ stale: false });
    act(() => {
      vi.advanceTimersByTime(STALE_FAILING_AFTER_MS);
    });
    expect(result.current.failing).toBe(false);
  });

  it('failing clears when stale goes false after the timer has fired', () => {
    const { result, rerender } = renderHook(({ stale }) => useGitHubReachability(stale), {
      initialProps: { stale: true },
    });
    act(() => {
      vi.advanceTimersByTime(STALE_FAILING_AFTER_MS + 1);
    });
    expect(result.current.failing).toBe(true);
    rerender({ stale: false });
    act(() => {});
    expect(result.current.failing).toBe(false);
  });
});
