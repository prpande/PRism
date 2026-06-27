import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MergedAnnouncer } from './MergedAnnouncer';

describe('MergedAnnouncer', () => {
  let rafCallbacks: FrameRequestCallback[];
  let originalRaf: typeof requestAnimationFrame;

  beforeEach(() => {
    rafCallbacks = [];
    originalRaf = globalThis.requestAnimationFrame;
    // Capture rAF callbacks so we can flush them manually
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    rafCallbacks = [];
  });

  function flushRaf() {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    cbs.forEach((cb) => cb(performance.now()));
  }

  it('announces "Pull request merged" when isMerged transitions false → true', () => {
    const onMerged = vi.fn();
    const { rerender } = render(<MergedAnnouncer isMerged={false} onMerged={onMerged} />);

    // No announcement yet
    expect(screen.getByTestId('pr-merged-status').textContent).toBe('');

    rerender(<MergedAnnouncer isMerged={true} onMerged={onMerged} />);

    expect(screen.getByTestId('pr-merged-status').textContent).toBe('Pull request merged');
  });

  it('calls onMerged after a requestAnimationFrame when isMerged transitions false → true', () => {
    const onMerged = vi.fn();
    const { rerender } = render(<MergedAnnouncer isMerged={false} onMerged={onMerged} />);

    rerender(<MergedAnnouncer isMerged={true} onMerged={onMerged} />);

    // onMerged not called yet (waits for rAF)
    expect(onMerged).not.toHaveBeenCalled();

    act(() => {
      flushRaf();
    });

    expect(onMerged).toHaveBeenCalledTimes(1);
  });

  it('does NOT announce when isMerged is true on initial mount (already-merged PR)', () => {
    const onMerged = vi.fn();
    render(<MergedAnnouncer isMerged={true} onMerged={onMerged} />);

    expect(screen.getByTestId('pr-merged-status').textContent).toBe('');

    act(() => {
      flushRaf();
    });

    expect(onMerged).not.toHaveBeenCalled();
  });

  it('does NOT re-announce when re-rendered while isMerged stays true', () => {
    const onMerged = vi.fn();
    const { rerender } = render(<MergedAnnouncer isMerged={false} onMerged={onMerged} />);

    rerender(<MergedAnnouncer isMerged={true} onMerged={onMerged} />);
    act(() => {
      flushRaf();
    });
    expect(onMerged).toHaveBeenCalledTimes(1);

    // Re-render with isMerged still true
    rerender(<MergedAnnouncer isMerged={true} onMerged={onMerged} />);
    act(() => {
      flushRaf();
    });

    // Still only called once
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pr-merged-status').textContent).toBe('Pull request merged');
  });
});
