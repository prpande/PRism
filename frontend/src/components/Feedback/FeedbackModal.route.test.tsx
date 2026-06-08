// Unit-tests for FeedbackModalRoutes (NOT App — App wiring is Task 16).
// Mirrors HelpModal.route.test.tsx: exercises the routing layer in isolation
// by rendering FeedbackModalRoutes inside a MemoryRouter at /feedback.

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub submitFeedback so network calls don't escape into jsdom.
vi.mock('../../api/feedback', () => ({ submitFeedback: vi.fn() }));

import { FeedbackModalRoutes } from './FeedbackModalRoutes';

function renderAt(
  path: string,
  props: Partial<React.ComponentProps<typeof FeedbackModalRoutes>> = {},
) {
  const merged = {
    isAuthed: true,
    unauthedTarget: '/welcome',
    host: 'https://github.com',
    ...props,
  };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FeedbackModalRoutes {...merged} />
    </MemoryRouter>,
  );
}

describe('FeedbackModalRoutes', () => {
  beforeEach(() => {
    // Ensure no stale prism bridge bleeds between tests.
    delete (window as unknown as { prism?: unknown }).prism;
  });

  it('authed user: /feedback renders the "Send feedback" dialog', () => {
    renderAt('/feedback', { isAuthed: true });
    expect(screen.getByRole('dialog', { name: /send feedback/i })).toBeInTheDocument();
  });

  it('first-run (isAuthed=false): /feedback still renders the dialog (auth-agnostic route)', () => {
    renderAt('/feedback', { isAuthed: false });
    expect(screen.getByRole('dialog', { name: /send feedback/i })).toBeInTheDocument();
  });

  it('non-/feedback path: no dialog rendered', () => {
    renderAt('/inbox', { isAuthed: true });
    expect(screen.queryByRole('dialog', { name: /send feedback/i })).toBeNull();
  });
});
