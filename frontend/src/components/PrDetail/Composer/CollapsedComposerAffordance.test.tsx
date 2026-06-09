// CollapsedComposerAffordance.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CollapsedComposerAffordance } from './CollapsedComposerAffordance';

describe('CollapsedComposerAffordance', () => {
  it('is a button with the given label + aria-label and opens on click', () => {
    const onOpen = vi.fn();
    render(<CollapsedComposerAffordance label="Reply…" ariaLabel="Reply to thread" onOpen={onOpen} />);
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

  it('is inert under readOnly (no open on click)', () => {
    const onOpen = vi.fn();
    render(
      <CollapsedComposerAffordance label="Reply…" ariaLabel="Reply to thread" readOnly onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reply to thread' }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
