import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PreSubmitValidatorCard } from '../src/components/PrDetail/SubmitDialog/PreSubmitValidatorCard';

describe('PreSubmitValidatorCard (spec § 14.1)', () => {
  it('renders nothing when there are no results (Noop / aiPreview off)', () => {
    const { container } = render(<PreSubmitValidatorCard results={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the canned Suggestion with the ai-tint card styling when results are supplied', () => {
    const { container } = render(
      <PreSubmitValidatorCard
        results={[
          {
            severity: 'Suggestion',
            message: '3 inline threads on the same file (`src/Foo.cs`) — consider consolidating?',
          },
        ]}
      />,
    );
    expect(screen.getByText(/3 inline threads on the same file/)).toBeInTheDocument();
    const card = container.querySelector('.ai-validator-card');
    expect(card).not.toBeNull();
    expect(card).toHaveClass('ai-tint');
  });

  it('renders the severity as a chip-status-* chip', () => {
    render(<PreSubmitValidatorCard results={[{ severity: 'Suggestion', message: 'm' }]} />);
    const chip = screen.getByText(/suggestion/i);
    expect(chip).toHaveClass('chip', 'chip-status-suggestion');
  });

  it('renders the Show me affordance as a disabled button (dead link in placeholder mode)', () => {
    render(<PreSubmitValidatorCard results={[{ severity: 'Suggestion', message: 'm' }]} />);
    const showMe = screen.getByRole('button', { name: /show me/i });
    expect(showMe).toBeDisabled();
    expect(showMe).toHaveAttribute('aria-disabled', 'true');
  });

  it('maps Concern and Blocking to their chip modifiers', () => {
    const { rerender } = render(
      <PreSubmitValidatorCard results={[{ severity: 'Concern', message: 'm' }]} />,
    );
    expect(screen.getByText(/concern/i)).toHaveClass('chip-status-concern');
    rerender(<PreSubmitValidatorCard results={[{ severity: 'Blocking', message: 'm' }]} />);
    expect(screen.getByText(/blocking/i)).toHaveClass('chip-status-blocking');
  });
});
