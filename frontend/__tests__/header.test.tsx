import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { Header } from '../src/components/Header/Header';

const preferencesBody = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false },
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
};

const server = setupServer(
  http.get('/api/preferences', () => HttpResponse.json(preferencesBody)),
  http.get('/api/auth/state', () =>
    HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header />
    </MemoryRouter>,
  );
}

describe('Header', () => {
  it('renders logo + Inbox/Settings/Setup tabs + global-search placeholder', () => {
    renderAt('/');
    expect(screen.getByText(/PRism/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^settings$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /setup/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/jump to PR or file/i)).toBeInTheDocument();
  });

  it('marks Inbox active on "/"', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /inbox/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^settings$/i })).not.toHaveAttribute('aria-current');
  });

  it('marks Settings active on "/settings" and not Setup', () => {
    renderAt('/settings');
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /setup/i })).not.toHaveAttribute('aria-current');
  });

  it('marks Settings active (NOT Setup) on "/setup?replace=1" — Replace flow is a Settings affordance per spec § 2.1', () => {
    renderAt('/setup?replace=1');
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /setup/i })).not.toHaveAttribute('aria-current');
  });

  it('marks Setup active (NOT Settings) on "/setup" with no replace param', () => {
    renderAt('/setup');
    expect(screen.getByRole('link', { name: /setup/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^settings$/i })).not.toHaveAttribute('aria-current');
  });

  it('prefixes the Setup label with the first-run "·" indicator when !hasToken', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    renderAt('/setup');
    const setupTab = await screen.findByRole('link', { name: /setup/i });
    await waitFor(() => expect(setupTab.textContent).toMatch(/^·\s*setup$/i));
  });

  it('keeps Settings active on a nested settings route (future-proofing for /settings/<sub>)', () => {
    renderAt('/settings/profile');
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('omits the "·" indicator once a token is configured', async () => {
    renderAt('/setup');
    const setupTab = await screen.findByRole('link', { name: /setup/i });
    await waitFor(() => expect(setupTab.textContent?.trim()).toBe('Setup'));
  });
});
