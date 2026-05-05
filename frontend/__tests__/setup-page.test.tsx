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
        <Route path="/inbox-shell" element={<div>InboxShellMock</div>} />
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

  it('routes to /inbox-shell on successful PAT submission', async () => {
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({ ok: true, login: 'octocat', host: 'https://github.com' }),
      ),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_test');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('InboxShellMock')).toBeInTheDocument();
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
});
