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
  it('hides the save button when closedBanner and shows the merged note', () => {
    render(<ComposerActionsBar {...baseProps} closedBanner prState="merged" />);
    expect(screen.queryByRole('button', { name: 'Add to review' })).toBeNull();
    expect(screen.getByText(/comments post immediately/)).toBeInTheDocument();
  });
  it('renders postError as an alert', () => {
    render(<ComposerActionsBar {...baseProps} postError="boom" />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
