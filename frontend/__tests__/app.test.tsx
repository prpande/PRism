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
    preferences: {
      ui: { theme: 'system', accent: 'indigo', density: 'comfortable' },
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
  it('routes to /welcome on first run (no token)', async () => {
    // #212: a true first-run user (!hasToken) lands on the welcome screen, NOT
    // the cold /setup token form.
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
    expect(await screen.findByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get started/i })).toBeInTheDocument();
    // Not the setup screen.
    expect(screen.queryByText(/connect to github/i)).toBeNull();
    // #130: first-run still hides the nav entirely.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();
  });

  it('reachable /setup directly while unauthed (not bounced to /welcome)', async () => {
    // #212: /setup stays directly reachable so a first-run user mid-typing is not
    // bounced. Navigating straight to /setup shows the token form.
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
  });

  it('authed user navigating to /welcome is redirected to / (Inbox)', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/welcome']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByPlaceholderText(/paste a pr url/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
  });

  it('first-run /settings redirects to /welcome (all four guard sites change together)', async () => {
    // #212: the spec warns "all four redirect sites change together — missing one
    // leaks a first-run user back to /setup". This guards the /settings site.
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get started/i })).toBeInTheDocument();
    expect(screen.queryByText(/connect to github/i)).toBeNull();
  });

  it('first-run /pr/* deep link redirects to /welcome (PR ref dropped)', async () => {
    // #212: a never-connected user hitting a PR deep link lands on /welcome
    // (consistent with the catch-all); the PR ref is intentionally dropped.
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/123']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get started/i })).toBeInTheDocument();
    expect(screen.queryByText(/connect to github/i)).toBeNull();
  });

  it('unknown route redirects a first-run user to /welcome (catch-all site)', async () => {
    // #212: the `*` catch-all is the fourth modified redirect site; an unknown
    // path in a no-token state must also land on /welcome, not /setup.
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
    expect(screen.queryByText(/connect to github/i)).toBeNull();
  });

  it('re-auth session starting at /welcome redirects to /setup (hasToken arm, not /welcome or Inbox)', async () => {
    // #212: pins the /welcome ternary's `hasToken && !isAuthed` arm. A token-bearing
    // session whose token is rejected must never rest on /welcome or the Inbox — it
    // routes to /setup (unauthedTarget resolves to /setup because hasToken is true).
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/welcome']}>
        <App />
      </MemoryRouter>,
    );
    // Authed first → Inbox (the /welcome authed arm redirects to /).
    expect(await screen.findByPlaceholderText(/paste a pr url/i)).toBeInTheDocument();
    // Token rejected mid-session → must land on /setup, not /welcome, not Inbox.
    window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
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
    // Auth failure now surfaces as a centered ErrorModal (alertdialog), not a bare alert.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent("Couldn't load auth state");
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
    // #130 no-regress: host-mismatch is an early return before <Header>, so no nav.
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('hides the header nav when a token exists but auth is rejected, and restores it on recovery', async () => {
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
    // Authed: nav is visible.
    expect(await screen.findByRole('link', { name: /inbox/i })).toBeInTheDocument();

    // 401 mid-session → isAuthed=false → nav hidden, bounced to /setup.
    window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
    // #212: re-auth (token present, rejected) goes to /setup, never the welcome hero.
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();

    // Recovery → nav restored.
    window.dispatchEvent(new CustomEvent('prism-auth-recovered'));
    expect(await screen.findByRole('link', { name: /inbox/i })).toBeInTheDocument();
  });
});
