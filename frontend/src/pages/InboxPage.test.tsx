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
  it('renders an alertdialog titled "Couldn\'t load inbox"', () => {
    render(<InboxPage />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent("Couldn't load inbox");
  });

  it('renders the "Try again" button INSIDE the alertdialog', () => {
    render(<InboxPage />);
    const dialog = screen.getByRole('alertdialog');
    const tryAgain = screen.getByRole('button', { name: /try again/i });
    // The recovery action is a control within the labelled dialog (one unit).
    expect(dialog).toContainElement(tryAgain);
  });
});
