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

  it('renders a bare glyph trigger (no text label) with data-readiness + aria-label', () => {
    renderBadge('behind-base');
    const trigger = screen.getByRole('button', { name: 'Merge readiness: Behind' });
    expect(trigger).toHaveAttribute('data-readiness', 'behind-base');
    // #593 — the badge is an icon now, not a text chip.
    expect(trigger.querySelector('svg')).not.toBeNull();
    expect(trigger).not.toHaveTextContent('Behind');
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

  it('renders a glyph for ready-with-changes-requested (success tone, no dot)', () => {
    const { container } = renderBadge('ready-with-changes-requested');
    const trigger = container.querySelector('[data-readiness="ready-with-changes-requested"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.querySelector('svg')).not.toBeNull();
    // the old amber-dot affordance is gone — this state has its own glyph now.
    expect(container.querySelector('[data-readiness-dot]')).toBeNull();
  });

  it('renders the people section with named reviewers, suppressing the count fallback', () => {
    renderBadge('review-required', {
      approvals: 1,
      approvers: [{ login: 'alice', avatarUrl: null }],
      awaitingReviewers: [{ login: 'bob', avatarUrl: null }],
    });
    act(() => screen.getAllByRole('button')[0].focus());
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Approved');
    expect(tip).toHaveTextContent('alice');
    expect(tip).toHaveTextContent('Waiting on');
    expect(tip).toHaveTextContent('bob');
    // names present → the "1 approval" count-only fallback line is suppressed.
    expect(tip).not.toHaveTextContent('1 approval');
  });
});
