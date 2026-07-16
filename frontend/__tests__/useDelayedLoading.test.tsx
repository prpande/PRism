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

  // #145 — a second loading cycle beginning inside the hold window must re-stamp the hold
  // anchor, so ITS completion gets the full anti-flicker hold instead of inheriting the
  // first cycle's nearly-expired window (stale showStartedAt → premature hide).
  it('re-stamps the hold anchor when a second cycle starts during the hold (#145)', () => {
    const { result, rerender } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: true },
    });
    act(() => {
      vi.advanceTimersByTime(100); // shown at T=100
    });
    rerender({ isLoading: false }); // T=100: hide scheduled for T=400
    act(() => {
      vi.advanceTimersByTime(100); // T=200
    });
    rerender({ isLoading: true }); // second cycle starts inside the hold → anchor re-stamps
    act(() => {
      vi.advanceTimersByTime(10); // T=210
    });
    rerender({ isLoading: false }); // cycle 2 completes: hold must run to T=200+300=500
    act(() => {
      vi.advanceTimersByTime(280); // T=490 — the stale anchor would have hidden at T=400
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(30); // T=520 — past the re-stamped hold
    });
    expect(result.current).toBe(false);
  });

  // #145 — N-cycle chaining contract: during a sustained burst (each cycle starting inside
  // the previous hold) the skeleton stays up continuously — no mid-burst flicker-hide — and
  // once the burst stops it hides within HOLD_MS of the LAST cycle's re-stamped anchor.
  it('chains holds across a rapid burst and settles after the last cycle (#145)', () => {
    const { result, rerender } = renderHook(({ isLoading }) => useDelayedLoading(isLoading), {
      initialProps: { isLoading: true },
    });
    act(() => {
      vi.advanceTimersByTime(100); // shown at T=100
    });
    for (let i = 0; i < 3; i++) {
      rerender({ isLoading: false });
      act(() => {
        vi.advanceTimersByTime(150); // idle 150ms — inside the 300ms hold
      });
      expect(result.current).toBe(true); // continuous through the burst, never flickers hidden
      rerender({ isLoading: true }); // next cycle re-stamps the anchor
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }
    rerender({ isLoading: false }); // burst over; last anchor is the final cycle's start
    act(() => {
      vi.advanceTimersByTime(240); // still inside the final re-stamped hold (50ms elapsed + 240)
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(20); // past it — bounded settle, no lingering timer
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
