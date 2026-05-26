import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SetupPage } from '../src/pages/SetupPage';
import { ToastProvider, ToastContainer } from '../src/components/Toast';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderRouted(initialPath = '/setup') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/" element={<div>InboxMock</div>} />
          <Route path="/settings" element={<div>SettingsMock</div>} />
        </Routes>
        <ToastContainer />
      </ToastProvider>
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

  describe('replace mode (?replace=1)', () => {
    it('renders a Cancel link to /settings when the URL has ?replace=1', async () => {
      renderRouted('/setup?replace=1');
      await screen.findByLabelText(/personal access token/i);
      const cancel = screen.getByRole('link', { name: /cancel/i });
      expect(cancel).toHaveAttribute('href', '/settings');
    });

    it('POSTs to /api/auth/replace and navigates to / on same-login success (no toast)', async () => {
      let replaceCalled = false;
      let connectCalled = false;
      server.use(
        http.post('/api/auth/replace', () => {
          replaceCalled = true;
          return HttpResponse.json({
            ok: true,
            login: 'octocat',
            host: 'https://github.com',
            identityChanged: false,
          });
        }),
        http.post('/api/auth/connect', () => {
          connectCalled = true;
          return HttpResponse.json({ ok: true, login: 'octocat', host: 'https://github.com' });
        }),
      );
      renderRouted('/setup?replace=1');
      await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_new');
      await userEvent.click(screen.getByRole('button', { name: /continue/i }));
      expect(await screen.findByText('InboxMock')).toBeInTheDocument();
      expect(replaceCalled).toBe(true);
      expect(connectCalled).toBe(false);
      // No identity-change toast on same-login replace.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('surfaces an identity-changed success toast naming the new login when identityChanged=true', async () => {
      server.use(
        http.post('/api/auth/replace', () =>
          HttpResponse.json({
            ok: true,
            login: 'bob',
            host: 'https://github.com',
            identityChanged: true,
          }),
        ),
      );
      renderRouted('/setup?replace=1');
      await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_bob');
      await userEvent.click(screen.getByRole('button', { name: /continue/i }));
      // Toast text fragments — message describes the new login + the drafts-preserved
      // / Node-IDs-cleared semantics. Spec § 3.2.1.
      expect(await screen.findByText(/Connected as bob/)).toBeInTheDocument();
      expect(screen.getByText(/Drafts preserved/)).toBeInTheDocument();
      expect(screen.getByText(/pending review IDs cleared/)).toBeInTheDocument();
      // Navigation still fires.
      expect(await screen.findByText('InboxMock')).toBeInTheDocument();
    });

    it('maps the 409 submit-in-flight error to a user-facing message with the PR ref', async () => {
      server.use(
        http.post(
          '/api/auth/replace',
          () =>
            new HttpResponse(
              JSON.stringify({
                ok: false,
                error: 'submit-in-flight',
                prRef: 'octocat/Hello-World/42',
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      );
      renderRouted('/setup?replace=1');
      await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_busy');
      await userEvent.click(screen.getByRole('button', { name: /continue/i }));
      expect(await screen.findByText(/submit is in progress/i)).toBeInTheDocument();
      expect(screen.getByText(/octocat\/Hello-World\/42/)).toBeInTheDocument();
      // Still on /setup — no navigation away from the form.
      expect(screen.queryByText('InboxMock')).not.toBeInTheDocument();
    });

    it('maps a 400 validation-failed error to "GitHub rejected this token"', async () => {
      server.use(
        http.post(
          '/api/auth/replace',
          () =>
            new HttpResponse(JSON.stringify({ ok: false, error: 'validation-failed' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );
      renderRouted('/setup?replace=1');
      await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_bad');
      await userEvent.click(screen.getByRole('button', { name: /continue/i }));
      expect(await screen.findByText(/GitHub rejected this token/i)).toBeInTheDocument();
    });

    it('does NOT call /api/auth/connect when in replace mode (regression: cross-flow leak)', async () => {
      let connectCalled = false;
      server.use(
        http.post('/api/auth/connect', () => {
          connectCalled = true;
          return HttpResponse.json({ ok: true, login: 'octocat', host: 'https://github.com' });
        }),
        http.post('/api/auth/replace', () =>
          HttpResponse.json({
            ok: true,
            login: 'octocat',
            host: 'https://github.com',
            identityChanged: false,
          }),
        ),
      );
      renderRouted('/setup?replace=1');
      await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_x');
      await userEvent.click(screen.getByRole('button', { name: /continue/i }));
      await screen.findByText('InboxMock');
      expect(connectCalled).toBe(false);
    });
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
