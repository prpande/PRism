import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders children inside a pill and forwards aria-label + data-testid', () => {
    render(
      <Badge data-testid="b" aria-label="Resolved thread">
        Resolved
      </Badge>,
    );
    const el = screen.getByTestId('b');
    expect(el).toHaveTextContent('Resolved');
    expect(el).toHaveAttribute('aria-label', 'Resolved thread');
  });
});
