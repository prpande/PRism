import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';

vi.mock('../src/hooks/useInbox', () => ({
  useInbox: vi.fn(() => ({
    data: { sections: [], enrichments: {}, lastRefreshedAt: '', tokenScopeFooterEnabled: false },
    isLoading: false,
    error: null,
    reload: vi.fn(),
  })),
}));
vi.mock('../src/hooks/useInboxUpdates', () => ({
  useInboxUpdates: vi.fn(() => ({ hasUpdate: false, summary: '', dismiss: vi.fn() })),
}));
vi.mock('../src/hooks/useEventSource', () => ({
  EventStreamProvider: ({ children }: { children: React.ReactNode }) => children,
  useEventSource: vi.fn(() => null),
}));
vi.mock('../src/hooks/useCapabilities', () => ({
  useCapabilities: vi.fn(() => ({
    capabilities: { inboxEnrichment: false },
    error: null,
    refetch: vi.fn(),
  })),
}));
vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: vi.fn(() => ({
    preferences: { theme: 'system', accent: 'indigo', aiPreview: false },
    error: null,
    refetch: vi.fn(),
    set: vi.fn(),
  })),
}));

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('App routing', () => {
  it('routes to /setup when no token', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
  });

  it('routes to / (InboxPage) when token present', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByPlaceholderText(/paste a pr url/i)).toBeInTheDocument();
  });

  it('renders error UI when /api/auth/state fails', async () => {
    server.use(
      http.get('/api/auth/state', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('navigates to /setup when prism-auth-rejected event fires', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    // Wait for InboxPage to render (token is present)
    expect(await screen.findByPlaceholderText(/paste a pr url/i)).toBeInTheDocument();
    // Simulate a 401 coming back from any API call
    window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
    // App should now force /setup
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
  });

  it('renders host-change modal when hostMismatch present', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({
          hasToken: true,
          host: 'https://github.com',
          hostMismatch: { old: 'https://x.com', new: 'https://github.com' },
        }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
