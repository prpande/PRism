import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DraftsTabDisabled } from '../src/components/PrDetail/DraftsTab/DraftsTabDisabled';

describe('DraftsTabDisabled', () => {
  it('renders the S4 placeholder copy', () => {
    render(<DraftsTabDisabled />);
    expect(screen.getByText(/Drafts arrive in S4/i)).toBeInTheDocument();
  });

  it('explains why the tab is disabled', () => {
    render(<DraftsTabDisabled />);
    expect(screen.getByText(/comment composer/i)).toBeInTheDocument();
  });
});
