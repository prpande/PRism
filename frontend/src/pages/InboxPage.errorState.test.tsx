import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Drive the `error && !data` branch. Mock every hook InboxPage calls so the
// component renders the error state without needing real contexts/providers — and
// so usePreferences doesn't fall back to the live store and fire a background
// GET /api/preferences that would make this test non-deterministic.
const { reload } = vi.hoisted(() => ({ reload: vi.fn() }));
vi.mock('../hooks/useInbox', () => ({
  useInbox: () => ({ data: null, error: new Error('boom'), isLoading: false, reload }),
}));
vi.mock('../hooks/useInboxUpdates', () => ({
  useInboxUpdates: () => ({ announce: '' }),
}));
vi.mock('../hooks/useAiGate', () => ({
  useAiGate: () => false,
}));
// InboxPage calls usePreferences directly (initial sort + activity-rail visibility);
// stub it so no network fetch fires. preferences=null matches the pre-fetch state and
// the error branch renders regardless.
vi.mock('../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: null, error: null, refetch: vi.fn(), set: vi.fn() }),
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
