import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentlyClosedFooter } from './RecentlyClosedFooter';

describe('RecentlyClosedFooter', () => {
  it('renders the unconditional caption with no props', () => {
    render(<RecentlyClosedFooter />);
    expect(screen.getByText(/most recent first/i)).toBeInTheDocument();
  });
});
