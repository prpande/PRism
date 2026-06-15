import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeMinimap } from './ChangeMinimap';
import type { ChangeTick } from './diffChanges';

const ticks: ChangeTick[] = [
  { kind: 'add', topPct: 10, heightPct: 1, startLineNum: 10, addCount: 2, delCount: 0 },
  { kind: 'delete', topPct: 40, heightPct: 1, startLineNum: 20, addCount: 0, delCount: 1 },
  { kind: 'modify', topPct: 70, heightPct: 2, startLineNum: 30, addCount: 1, delCount: 1 },
];
const viewport = { topPct: 0, heightPct: 30 };

describe('ChangeMinimap', () => {
  it('renders one tick per change with a kind data-attr', () => {
    const { getAllByTestId } = render(
      <ChangeMinimap
        ticks={ticks}
        viewport={viewport}
        onGoToChange={() => {}}
        onScrollToRatio={() => {}}
      />,
    );
    const els = getAllByTestId('change-tick');
    expect(els).toHaveLength(3);
    expect(els[0]).toHaveAttribute('data-kind', 'add');
    expect(els[2]).toHaveAttribute('data-kind', 'modify');
  });

  it('jumps to a change when a tick is clicked', async () => {
    const onGo = vi.fn();
    const { getAllByTestId } = render(
      <ChangeMinimap
        ticks={ticks}
        viewport={viewport}
        onGoToChange={onGo}
        onScrollToRatio={() => {}}
      />,
    );
    await userEvent.click(getAllByTestId('change-tick')[1]);
    expect(onGo).toHaveBeenCalledWith(1);
  });

  it('does not crash when ticks shrink below a stale hovered index', async () => {
    // Hover the last tick, then re-render with fewer ticks (mimics navigating to
    // a shorter file via j/k with no mouseleave). The stale hovered index must
    // not dereference past the shrunk array.
    const { getAllByTestId, rerender, queryByText } = render(
      <ChangeMinimap
        ticks={ticks}
        viewport={viewport}
        onGoToChange={() => {}}
        onScrollToRatio={() => {}}
      />,
    );
    await userEvent.hover(getAllByTestId('change-tick')[2]);
    expect(queryByText(/change 3 of 3/)).toBeInTheDocument();
    expect(() =>
      rerender(
        <ChangeMinimap
          ticks={ticks.slice(0, 1)}
          viewport={viewport}
          onGoToChange={() => {}}
          onScrollToRatio={() => {}}
        />,
      ),
    ).not.toThrow();
    // The stale tooltip is gone (no out-of-range render).
    expect(queryByText(/change 3 of/)).not.toBeInTheDocument();
  });

  it('scrubs continuously while dragging the rail, and swallows the trailing click', () => {
    // The rail doubles as a scroll slider (#486 review): a press on a gap scrolls
    // there and the drag tracks the pointer; the click the browser fires after the
    // drag must not also re-scrub or jump.
    const onScroll = vi.fn();
    const onGo = vi.fn();
    const { container } = render(
      <ChangeMinimap
        ticks={ticks}
        viewport={viewport}
        onGoToChange={onGo}
        onScrollToRatio={onScroll}
      />,
    );
    const rail = container.firstElementChild as HTMLElement;
    // jsdom getBoundingClientRect is all-zero; give the rail a real box.
    rail.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 16, bottom: 100, height: 100, width: 16 }) as DOMRect;
    fireEvent.pointerDown(rail, { pointerId: 1, button: 0, clientX: 8, clientY: 50 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientX: 8, clientY: 80 });
    fireEvent.pointerUp(rail, { pointerId: 1, clientX: 8, clientY: 80 });
    // Pressed at y=50 (ratio 0.5) then dragged to y=80 (ratio 0.8).
    expect(onScroll.mock.calls.map((c) => c[0])).toEqual([0.5, 0.8]);
    // The post-drag click is swallowed — no extra scrub, no jump.
    fireEvent.click(rail, { clientX: 8, clientY: 80 });
    expect(onScroll).toHaveBeenCalledTimes(2);
    expect(onGo).not.toHaveBeenCalled();
  });

  it('keeps the bar expanded briefly after the pointer leaves, then collapses', () => {
    // Regression (#486 review): expansion must linger after the pointer strays so
    // it does not feel twitchy and the widened bar stays a stable target. A
    // re-entry within the grace window cancels the pending collapse.
    vi.useFakeTimers();
    try {
      const { container } = render(
        <ChangeMinimap
          ticks={ticks}
          viewport={viewport}
          onGoToChange={() => {}}
          onScrollToRatio={() => {}}
        />,
      );
      const rail = container.firstElementChild as HTMLElement;
      fireEvent.mouseEnter(rail);
      expect(rail).toHaveAttribute('data-expanded', 'true');
      // Leaving does not collapse immediately.
      fireEvent.mouseLeave(rail);
      act(() => vi.advanceTimersByTime(200));
      expect(rail).toHaveAttribute('data-expanded', 'true');
      // Re-entering within the grace window cancels the pending collapse.
      fireEvent.mouseEnter(rail);
      act(() => vi.advanceTimersByTime(500));
      expect(rail).toHaveAttribute('data-expanded', 'true');
      // Finally leaving and waiting out the grace window collapses it.
      fireEvent.mouseLeave(rail);
      act(() => vi.advanceTimersByTime(500));
      expect(rail).not.toHaveAttribute('data-expanded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is hidden from the accessibility tree', () => {
    const { container } = render(
      <ChangeMinimap
        ticks={ticks}
        viewport={viewport}
        onGoToChange={() => {}}
        onScrollToRatio={() => {}}
      />,
    );
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
