import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Drive the `error && !data` branch. Mock every hook InboxPage calls so the
// component renders the error state without needing real contexts/providers.
const { reload } = vi.hoisted(() => ({ reload: vi.fn() }));
vi.mock('../hooks/useInbox', () => ({
  useInbox: () => ({ data: null, error: new Error('boom'), isLoading: false, reload }),
}));
vi.mock('../hooks/useInboxUpdates', () => ({
  useInboxUpdates: () => ({ hasUpdate: false, summary: '', dismiss: vi.fn() }),
}));
vi.mock('../hooks/useAiGate', () => ({
  useAiGate: () => false,
}));

import { InboxPage } from './InboxPage';

describe('InboxPage error state', () => {
  it('renders the error message inside a role="alert" node', () => {
    render(<InboxPage />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load inbox.");
  });

  it('keeps the "Try again" button OUTSIDE the alert region', () => {
    render(<InboxPage />);
    const alert = screen.getByRole('alert');
    // a11y guarantee: the action button must not be announced as part of the alert.
    expect(alert.textContent).not.toContain('Try again');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
