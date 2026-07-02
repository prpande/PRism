// #328 — newly-gained dropdown dismissal + ARIA popup semantics
// (useDismissableMenu adoption). Pre-existing rendering behavior stays pinned
// by IterationTabStrip.test.tsx, which is intentionally unmodified.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { IterationTabStrip } from '../src/components/PrDetail/FilesTab/IterationTabStrip';
import { iter } from './helpers/prDetail';

// Five iterations → 3 inline + a 2-item "All iterations" overflow dropdown.
function renderWithOverflow() {
  const iterations = [iter(1), iter(2), iter(3), iter(4), iter(5)];
  render(
    <div>
      <IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={vi.fn()} />
      <button data-testid="outside">outside</button>
    </div>,
  );
  return screen.getByRole('button', { name: /show 2 more iterations/i });
}

describe('IterationTabStrip — dropdown dismissal (#328)', () => {
  it('closes the dropdown on Escape and returns focus to the trigger', async () => {
    const trigger = renderWithOverflow();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes the dropdown on a click outside the strip', async () => {
    const trigger = renderWithOverflow();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('treats an inline iteration tab as outside the dropdown boundary', async () => {
    const trigger = renderWithOverflow();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // Inline tabs sit outside the .iteration-tab-overflow wrapper, so clicking
    // one must close the dropdown (the boundary is the overflow div, NOT the
    // whole strip).
    await userEvent.click(screen.getByText('Iter 5'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the dropdown open when clicking inside it on a disabled option', async () => {
    const iterations = [iter(1, false), iter(2), iter(3), iter(4), iter(5)];
    render(<IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /show 2 more iterations/i }));
    // Pointer-down on a disabled option is still inside the boundary; the
    // dropdown only closes via selection, Esc, outside click, or the trigger.
    await userEvent.click(screen.getByText('Iter 1 (snapshot lost)'), {
      pointerEventsCheck: 0,
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('IterationTabStrip — ARIA popup semantics (#328)', () => {
  it('marks the trigger with aria-haspopup and wires aria-controls to the open dropdown', async () => {
    const trigger = renderWithOverflow();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    // Closed: aria-controls must not point at an absent id (axe
    // aria-valid-attr-value; cf. DiffSettingsMenu).
    expect(trigger).not.toHaveAttribute('aria-controls');
    await userEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu.id).toBeTruthy();
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('exposes the dropdown as a labelled menu of menuitems', async () => {
    const trigger = renderWithOverflow();
    await userEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: /all iterations/i });
    expect(menu).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });
});
