import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EmptyPrPlaceholder } from '../src/components/PrDetail/EmptyPrPlaceholder';

describe('EmptyPrPlaceholder', () => {
  it('renders an empty-state message about no commits', () => {
    render(<EmptyPrPlaceholder />);
    expect(screen.getByText(/no commits/i)).toBeInTheDocument();
  });

  it('has role="status" so screen readers announce it', () => {
    render(<EmptyPrPlaceholder />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
