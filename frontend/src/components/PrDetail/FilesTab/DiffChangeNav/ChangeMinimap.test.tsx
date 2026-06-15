import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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
