import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { InboxShellPage } from '../src/pages/InboxShellPage';

describe('InboxShellPage', () => {
  it('renders Inbox heading + coming soon copy', () => {
    render(<InboxShellPage />);
    expect(screen.getByRole('heading', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
