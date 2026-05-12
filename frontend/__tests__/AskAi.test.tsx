import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AskAiButton } from '../src/components/PrDetail/AskAiButton';
import { AskAiEmptyState } from '../src/components/PrDetail/AskAiEmptyState';

describe('AskAiButton (spec § 14.2)', () => {
  it('renders nothing when aiPreview is false', () => {
    const { container } = render(<AskAiButton aiPreview={false} onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Ask AI button when aiPreview is true', () => {
    render(<AskAiButton aiPreview onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /ask ai/i })).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<AskAiButton aiPreview onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /ask ai/i }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('AskAiEmptyState (spec § 14.2)', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<AskAiEmptyState open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the coming-in-v2 copy with no interactive chat surface when open', () => {
    render(<AskAiEmptyState open onClose={() => {}} />);
    expect(screen.getByText(/coming in v2/i)).toBeInTheDocument();
    // No chat input bar, no message bubbles, no "AI is typing" indicator.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('the close button fires onClose', () => {
    const onClose = vi.fn();
    render(<AskAiEmptyState open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
