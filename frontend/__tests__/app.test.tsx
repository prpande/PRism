import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'ci-failing': true,
        },
      },
      github: {
        host: 'https://github.com',
        configPath: '/fake/config.json',
        logsPath: '/fake/logs',
      },
    },
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

  it('lands on the Inbox after first-run token submission (no manual second click)', async () => {
    // Mirrors reality: /api/auth/state reports no token until the PAT is
    // committed by /api/auth/connect, after which it reports hasToken: true.
    let connected = false;
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: connected, host: 'https://github.com', hostMismatch: null }),
      ),
      http.post('/api/auth/connect', () => {
        connected = true;
        return HttpResponse.json({ ok: true, login: 'octocat', host: 'https://github.com' });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    // First run: no token yet → the Connect to GitHub screen.
    await screen.findByText(/connect to github/i, {}, { timeout: 5000 });
    // Paste a token and submit.
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_test');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    // Should land straight in the Inbox — NOT bounce back to the setup screen
    // and force a second "Get Started" click.
    expect(
      await screen.findByPlaceholderText(/paste a pr url/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20000);

  it('lands on the Inbox after the no-repos "Continue anyway" first-run path', async () => {
    // The onContinueAnyway flow has the SAME first-run race as onConnect: a
    // token with no repos selected shows the warning modal, and committing it
    // must `await refetch()` before navigate('/') or App's stale hasToken=false
    // bounces back to /setup. The token isn't live until the commit succeeds.
    let connected = false;
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: connected, host: 'https://github.com', hostMismatch: null }),
      ),
      // connect returns the no-repos warning WITHOUT committing the token.
      http.post('/api/auth/connect', () =>
        HttpResponse.json({ ok: true, warning: 'no-repos-selected', host: 'https://github.com' }),
      ),
      // commit is what actually makes the token live.
      http.post('/api/auth/connect/commit', () => {
        connected = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(/connect to github/i, {}, { timeout: 5000 });
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_test');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    // No-repos warning modal appears; commit via "Continue anyway".
    await userEvent.click(await screen.findByRole('button', { name: /continue anyway/i }));
    // Should land straight in the Inbox — not bounce back to /setup.
    expect(
      await screen.findByPlaceholderText(/paste a pr url/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20000);

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
