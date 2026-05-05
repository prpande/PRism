import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';

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
      http.get('/api/preferences', () =>
        HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
  });

  it('routes to /inbox-shell when token present', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
      http.get('/api/preferences', () =>
        HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: /inbox/i })).toBeInTheDocument();
  });

  it('renders error UI when /api/auth/state fails', async () => {
    server.use(
      http.get('/api/auth/state', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      http.get('/api/preferences', () =>
        HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();
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
      http.get('/api/preferences', () =>
        HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false }),
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
