// CollapsedComposerAffordance.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CollapsedComposerAffordance } from './CollapsedComposerAffordance';

describe('CollapsedComposerAffordance', () => {
  it('is a button with the given label + aria-label and opens on click', () => {
    const onOpen = vi.fn();
    render(
      <CollapsedComposerAffordance label="Reply…" ariaLabel="Reply to thread" onOpen={onOpen} />,
    );
    const btn = screen.getByRole('button', { name: 'Reply to thread' });
    expect(btn).toHaveTextContent('Reply…');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows the saved pill and continue-draft label when a draft exists', () => {
    render(
      <CollapsedComposerAffordance
        label="Continue draft…"
        ariaLabel="Reply to thread"
        hasDraft
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Continue draft…')).toBeInTheDocument();
    expect(screen.getByText('saved')).toBeInTheDocument();
  });

  it('is truly inert under readOnly — natively disabled, out of tab order, no open on click', () => {
    const onOpen = vi.fn();
    render(
      <CollapsedComposerAffordance
        label="Reply…"
        ariaLabel="Reply to thread"
        readOnly
        onOpen={onOpen}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Reply to thread' });
    // Native `disabled` removes it from the tab order and lets assistive tech
    // announce it as disabled — not a focusable button that silently no-ops.
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
