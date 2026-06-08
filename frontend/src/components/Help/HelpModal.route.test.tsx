// Mirrors the mock pattern in __tests__/app.test.tsx.
// Tests that /help and /feedback render their modal dialogs over the correct
// background page in both first-run (!hasToken) and authed (hasToken) states.

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const authState = vi.hoisted(() => ({
  value: { hasToken: false, host: 'https://github.com' } as Record<string, unknown>,
}));
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ authState: authState.value, error: null, refetch: vi.fn() }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: vi.fn(() => ({
    preferences: null,
    error: null,
    refetch: vi.fn(),
    set: vi.fn(),
  })),
}));
vi.mock('../../hooks/useEventSource', () => ({
  EventStreamProvider: ({ children }: { children: ReactNode }) => children,
  useEventSource: vi.fn(() => null),
}));
vi.mock('../../api/client', () => ({
  apiClient: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
  ApiError: class extends Error {},
}));
vi.mock('../../api/feedback', () => ({ submitFeedback: vi.fn() }));
// Hoist the inbox snapshot to a single stable object. The real `useInbox` holds
// `data` in `useState`, so its reference is stable across renders; a factory that
// rebuilt `{ data: { sections: [] } }` on every call would hand InboxPage a fresh
// `sections` array each render, re-firing FilterBar's onState effect → setState →
// re-render → loop (the authed /help background mounts the real InboxPage).
const inboxSnapshot = vi.hoisted(() => ({
  data: {
    sections: [] as never[],
    enrichments: {},
    lastRefreshedAt: '',
    tokenScopeFooterEnabled: false,
    ciProbeComplete: true,
  },
  isLoading: false,
  error: null,
  reload: vi.fn(),
}));
vi.mock('../../hooks/useInbox', () => ({
  useInbox: vi.fn(() => inboxSnapshot),
}));
vi.mock('../../hooks/useInboxUpdates', () => ({
  useInboxUpdates: vi.fn(() => ({ hasUpdate: false, summary: '', dismiss: vi.fn() })),
}));
vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: vi.fn(() => ({
    capabilities: { inboxEnrichment: false },
    error: null,
    refetch: vi.fn(),
  })),
}));

import { App } from '../../App';

class FakeEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage = null;
  onerror = null;
}

function renderAppAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('/help route renders as modal', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('first-run user: /help shows the dialog AND the welcome-card background', () => {
    authState.value = { hasToken: false, host: 'https://github.com' };
    renderAppAt('/help');
    // Modal dialog is present
    expect(screen.getByRole('dialog', { name: /help/i })).toBeInTheDocument();
    // Welcome page renders behind the modal (background)
    expect(screen.getByTestId('welcome-card')).toBeInTheDocument();
  });

  it('authed user: /help shows the dialog AND the inbox background', () => {
    authState.value = { hasToken: true, host: 'https://github.com' };
    renderAppAt('/help');
    // Modal dialog is present
    expect(screen.getByRole('dialog', { name: /help/i })).toBeInTheDocument();
    // Inbox page renders behind the modal (background)
    expect(screen.getByTestId('inbox-page')).toBeInTheDocument();
  });
});

describe('/feedback route renders as modal', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('first-run user: /feedback shows the "Send feedback" dialog AND the welcome-card background', () => {
    authState.value = { hasToken: false, host: 'https://github.com' };
    renderAppAt('/feedback');
    // Modal dialog is present
    expect(screen.getByRole('dialog', { name: /send feedback/i })).toBeInTheDocument();
    // Welcome page renders behind the modal (background)
    expect(screen.getByTestId('welcome-card')).toBeInTheDocument();
  });

  it('authed user: /feedback shows the "Send feedback" dialog AND the inbox background', () => {
    authState.value = { hasToken: true, host: 'https://github.com' };
    renderAppAt('/feedback');
    // Modal dialog is present
    expect(screen.getByRole('dialog', { name: /send feedback/i })).toBeInTheDocument();
    // Inbox page renders behind the modal (background)
    expect(screen.getByTestId('inbox-page')).toBeInTheDocument();
  });
});
