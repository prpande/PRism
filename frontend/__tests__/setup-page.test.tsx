import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SetupPage } from '../src/pages/SetupPage';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderRouted() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={<div>InboxMock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SetupPage', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
  });

  it('routes to / (InboxPage) on successful PAT submission', async () => {
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({ ok: true, login: 'octocat', host: 'https://github.com' }),
      ),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_test');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('InboxMock')).toBeInTheDocument();
  });

  it('renders the error pill on validation failure', async () => {
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: false,
          error: 'invalidtoken',
          detail: 'GitHub rejected this token.',
        }),
      ),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_bad');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/rejected/i)).toBeInTheDocument();
  });

  it('builds the PAT link from the configured GHES host', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({
          hasToken: false,
          host: 'https://github.acme.com',
          hostMismatch: null,
        }),
      ),
    );
    renderRouted();
    const link = await screen.findByRole('link', { name: /generate a token/i });
    expect(link.getAttribute('href')).toBe(
      'https://github.acme.com/settings/personal-access-tokens/new',
    );
  });

  it('renders a warning modal when connect returns no-repos-selected', async () => {
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: true,
          login: 'octocat',
          host: 'https://github.com',
          warning: 'no-repos-selected',
        }),
      ),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'github_pat_zero');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/no repos selected/i)).toBeInTheDocument();
    // Did NOT auto-redirect.
    expect(screen.queryByText('InboxMock')).not.toBeInTheDocument();
  });

  it('Continue anyway commits and routes to /', async () => {
    let commitCalled = false;
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: true,
          login: 'octocat',
          host: 'https://github.com',
          warning: 'no-repos-selected',
        }),
      ),
      http.post('/api/auth/connect/commit', () => {
        commitCalled = true;
        return HttpResponse.json({ ok: true, host: 'https://github.com' });
      }),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'github_pat_zero');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(await screen.findByRole('button', { name: /continue anyway/i }));
    expect(await screen.findByText('InboxMock')).toBeInTheDocument();
    expect(commitCalled).toBe(true);
  });

  it('Edit clicked during in-flight commit cancels navigation', async () => {
    // The Edit button stays enabled during commit so the user can always retreat.
    // If they click Edit while the commit is in-flight, the commit may still complete
    // server-side (we can't cancel it), but the page must NOT navigate to / —
    // navigating would override the user's stated intent to edit.
    let releaseCommit: (() => void) | undefined;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: true,
          login: 'octocat',
          host: 'https://github.com',
          warning: 'no-repos-selected',
        }),
      ),
      http.post('/api/auth/connect/commit', async () => {
        await commitGate;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'github_pat_zero');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Click Continue anyway — kicks off the commit (gated, won't resolve yet).
    await userEvent.click(await screen.findByRole('button', { name: /continue anyway/i }));
    // While commit is in-flight, click Edit.
    await userEvent.click(await screen.findByRole('button', { name: /edit token scope/i }));
    // Now release the commit response.
    releaseCommit!();

    // Wait long enough for the commit's `.then(navigate)` to flush — give the
    // route enough time to render InboxMock IF a (buggy) navigation fired.
    await new Promise((r) => setTimeout(r, 50));

    // Navigation must NOT have occurred — Edit is the user's last expressed intent.
    expect(screen.queryByText('InboxMock')).not.toBeInTheDocument();
    // And the modal stays dismissed.
    expect(screen.queryByText(/no repos selected/i)).not.toBeInTheDocument();
  });

  it('Edit token scope dismisses the modal without commit', async () => {
    let commitCalled = false;
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: true,
          login: 'octocat',
          host: 'https://github.com',
          warning: 'no-repos-selected',
        }),
      ),
      http.post('/api/auth/connect/commit', () => {
        commitCalled = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'github_pat_zero');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(await screen.findByRole('button', { name: /edit token scope/i }));
    expect(screen.queryByText(/no repos selected/i)).not.toBeInTheDocument();
    expect(commitCalled).toBe(false);
    expect(screen.queryByText('InboxMock')).not.toBeInTheDocument();
  });
});
