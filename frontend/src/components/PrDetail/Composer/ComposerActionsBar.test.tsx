import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ComposerActionsBar } from './ComposerActionsBar';

const baseProps = {
  previewMode: false,
  onTogglePreview: vi.fn(),
  badge: 'saved' as const,
  saveDisabled: false,
  saveTooltip: undefined,
  addLabel: 'Add to review',
  closedBanner: false,
  prState: 'open' as const,
  postNowDisabled: false,
  postNowTooltip: undefined,
  posting: false,
  postError: null as string | null,
  readOnly: false,
  onDiscardClick: vi.fn(),
  onSaveClick: vi.fn(),
  onPostNow: vi.fn(),
};

describe('ComposerActionsBar', () => {
  it('renders buttons in canonical order for an open PR', () => {
    const { container } = render(<ComposerActionsBar {...baseProps} />);
    const bar = container.querySelector('.composer-actions') as HTMLElement;
    const buttons = within(bar)
      .getAllByRole('button')
      .map((b) => b.textContent);
    // AiComposerAssistant renders null (AI gate off in tests); badge is a span, not a button.
    expect(buttons).toEqual(['Preview', 'Discard', 'Add to review', 'Comment']);
  });
  it('hides the save button and the merged note when closedBanner', () => {
    render(<ComposerActionsBar {...baseProps} closedBanner prState="merged" />);
    expect(screen.queryByRole('button', { name: 'Add to review' })).toBeNull();
    expect(screen.queryByText(/comments post immediately/)).toBeNull();
    // The merged context is preserved as the button's TOOLTIP (title) for mouse
    // users AND an aria-describedby sr-only description for keyboard/SR users —
    // NOT the accessible name ("Comment" stays the name; WCAG 2.5.3).
    const commentBtn = screen.getByRole('button', { name: 'Comment' });
    expect(commentBtn).toHaveAttribute('title', 'Post directly to this merged PR');
    const descId = commentBtn.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId as string)).toHaveTextContent(
      'Post directly to this merged PR',
    );
  });
  it('renders postError as an alert', () => {
    render(<ComposerActionsBar {...baseProps} postError="boom" />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
