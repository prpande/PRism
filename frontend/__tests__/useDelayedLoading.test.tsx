import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDelayedLoading } from '../src/hooks/useDelayedLoading';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDelayedLoading — 100ms wait + 300ms hold', () => {
  it('returns false initially when not loading', () => {
    const { result } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: false },
    });
    expect(result.current).toBe(false);
  });

  it('does not show skeleton during the first 100ms of loading', () => {
    const { result } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: true },
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(result.current).toBe(false);
  });

  it('shows skeleton after the 100ms wait elapses while still loading', () => {
    const { result } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: true },
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(true);
  });

  it('never shows skeleton when loading finishes within the wait window', () => {
    const { result, rerender } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: true },
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender({ isLoading: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);
  });

  it('holds skeleton visible for 300ms once shown, even if loading flips false', () => {
    const { result, rerender } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: true },
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(true);
    rerender({ isLoading: false });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current).toBe(false);
  });

  it('stays true if loading restarts during the hold window', () => {
    const { result, rerender } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: true },
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ isLoading: false });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    rerender({ isLoading: true });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(true);
  });
});
