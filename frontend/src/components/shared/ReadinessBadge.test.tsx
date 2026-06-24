import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ReadinessBadge } from './ReadinessBadge';
import { ReadinessTooltipProvider } from './ReadinessTooltipContext';
import type { MergeReadiness } from './mergeReadiness';

function renderBadge(
  readiness: MergeReadiness,
  props: Partial<React.ComponentProps<typeof ReadinessBadge>> = {},
) {
  return render(
    <ReadinessTooltipProvider>
      <ReadinessBadge readiness={readiness} variant="compact" id="b1" {...props} />
      <ReadinessBadge readiness="ready" variant="compact" id="b2" />
    </ReadinessTooltipProvider>,
  );
}

describe('ReadinessBadge', () => {
  it('renders nothing for none/merged/closed', () => {
    for (const s of ['none', 'merged', 'closed'] as MergeReadiness[]) {
      const { container } = render(
        <ReadinessTooltipProvider>
          <ReadinessBadge readiness={s} variant="compact" id="x" />
        </ReadinessTooltipProvider>,
      );
      expect(container.querySelector('[data-readiness]')).toBeNull();
    }
  });

  it('renders the short label + chip class for an open state', () => {
    renderBadge('behind-base');
    const chip = screen.getByText('Behind');
    expect(chip.className).toContain('chip-readiness-behind-base');
  });

  it('opens the popover immediately on focus and closes on Escape', async () => {
    renderBadge('conflicts');
    const trigger = screen.getAllByRole('button')[0];
    act(() => trigger.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Resolve merge conflicts');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('is a singleton — opening one popover closes another', () => {
    renderBadge('conflicts');
    const [t1, t2] = screen.getAllByRole('button');
    act(() => t1.focus());
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    act(() => t2.focus());
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('This PR can be merged.');
  });

  it('re-renders popover content in place when readiness changes while open', () => {
    const { rerender } = renderBadge('conflicts');
    act(() => screen.getAllByRole('button')[0].focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Resolve merge conflicts');
    rerender(
      <ReadinessTooltipProvider>
        <ReadinessBadge readiness="ready" variant="compact" id="b1" />
        <ReadinessBadge readiness="ready" variant="compact" id="b2" />
      </ReadinessTooltipProvider>,
    );
    // The same provider instance stays mounted across rerender (same element structure).
    // b1 is still open (openId="b1" in context), so the tooltip should now show "ready" copy.
    expect(screen.getByRole('tooltip')).toHaveTextContent('This PR can be merged.');
  });

  it('shows collapsed reviewer counts, suppressing zero clauses', () => {
    renderBadge('changes-requested', { approvals: 1, changesRequested: 2 });
    act(() => screen.getAllByRole('button')[0].focus());
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Changes requested by 2');
    expect(tip).toHaveTextContent('1 approval');
    expect(tip).not.toHaveTextContent('0');
  });

  it('renders an aria-hidden amber dot for ready-with-changes-requested', () => {
    const { container } = renderBadge('ready-with-changes-requested');
    const dot = container.querySelector('[data-readiness-dot]');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });
});
