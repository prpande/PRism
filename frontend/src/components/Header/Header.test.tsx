import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { Header } from './Header';

const preferencesBody = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
  inbox: {
    sections: {
      'review-requested': true,
      'awaiting-author': true,
      'authored-by-me': true,
      mentioned: true,
      'recently-closed': true,
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

function renderAt(path: string, isAuthed: boolean = true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header isAuthed={isAuthed} />
    </MemoryRouter>,
  );
}

describe('Header', () => {
  it('renders logo + Inbox/Settings tabs (no Setup tab) when authed', () => {
    renderAt('/');
    expect(screen.getByAltText('PRism')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^settings$/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /setup/i })).toBeNull();
  });

  it('hides the whole nav (no landmark, no tab links) when not authed; keeps the logo + spacer', () => {
    renderAt('/setup', false);
    // #215: on /setup the name is presented as the visible wordmark (the mark
    // itself goes decorative), so the lockup is proven by the wordmark text.
    expect(screen.getByText('PRism')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /^settings$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /setup/i })).toBeNull();
    // The spacer must survive nav removal — it owns the middle so the Logo stays
    // left-flush (not re-centered). Guards the "wrap spacer inside {isAuthed &&}"
    // mistake that would collapse the layout.
    expect(screen.getByTestId('header-spacer')).toBeInTheDocument();
  });

  it('marks Inbox active on "/"', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /inbox/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^settings$/i })).not.toHaveAttribute('aria-current');
  });

  it('marks Settings active on "/settings"', () => {
    renderAt('/settings');
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps Settings active on "/setup?replace=1" — Replace flow is a Settings affordance (authed)', () => {
    renderAt('/setup?replace=1', true);
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps Settings active on a nested settings route (/settings/<sub>)', () => {
    renderAt('/settings/profile');
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // #119: the ⌘K search palette isn't built, so the disabled box stays hidden.
  it('does not render the disabled global-search box on the Inbox (#119)', () => {
    renderAt('/');
    expect(screen.queryByPlaceholderText(/jump to PR or file/i)).toBeNull();
    expect(screen.queryByLabelText(/global search/i)).toBeNull();
  });

  it('does not render the disabled global-search box off the Inbox either (#119)', () => {
    renderAt('/settings');
    expect(screen.queryByPlaceholderText(/jump to PR or file/i)).toBeNull();
    expect(screen.queryByLabelText(/global search/i)).toBeNull();
  });
});

// #215 — the "PRism" wordmark fills the empty no-nav header. Header only sees
// isAuthed + pathname, so first-run /setup and rejected-token re-auth are the
// SAME render here (both isAuthed=false at /setup); one test covers both. The
// per-state distinction (hasToken) lives in App, not Header.
describe('Header wordmark (#215)', () => {
  it('shows the visible wordmark on /setup (first-run and re-auth); mark is decorative', () => {
    renderAt('/setup', false);
    expect(screen.getByText('PRism')).toBeInTheDocument();
    expect(screen.queryByAltText('PRism')).toBeNull();
  });

  it('suppresses the wordmark on /welcome; the mark keeps the name (no double "PRism")', () => {
    renderAt('/welcome', false);
    expect(screen.queryByText('PRism')).toBeNull();
    expect(screen.getByAltText('PRism')).toBeInTheDocument();
  });

  it('shows no visible wordmark in the authed header; mark keeps the name', () => {
    renderAt('/', true);
    expect(screen.queryByText('PRism')).toBeNull();
    expect(screen.getByAltText('PRism')).toBeInTheDocument();
  });
});

describe('Header gear', () => {
  it('renders a Settings gear link to /settings/appearance when authed', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      '/settings/appearance',
    );
  });

  it('marks the gear active while a settings modal is open', () => {
    renderAt('/settings/system');
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps Inbox as a tab', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('does not render the gear first-run (unauthed)', () => {
    renderAt('/setup', false);
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  });
});

describe('Header help', () => {
  it('renders a Help link to /help when authed', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
  });

  it('marks the Help link active on /help', () => {
    renderAt('/help');
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides the Help link when not authed', () => {
    renderAt('/', false);
    expect(screen.queryByRole('link', { name: 'Help' })).toBeNull();
  });
});

describe('Header feedback', () => {
  // Query by role=link: on /feedback the modal's dialog + submit button also carry a
  // "send feedback" accessible name, so a bare /feedback/i text query would be ambiguous.
  it('renders a Send feedback link to /feedback when authed', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /send feedback/i })).toHaveAttribute(
      'href',
      '/feedback',
    );
  });

  it('marks the Feedback link active on /feedback', () => {
    renderAt('/feedback');
    expect(screen.getByRole('link', { name: /send feedback/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('hides the Feedback link when not authed', () => {
    renderAt('/', false);
    expect(screen.queryByRole('link', { name: /send feedback/i })).toBeNull();
  });

  it('orders the right-side cluster Settings · Help · Feedback', () => {
    renderAt('/');
    const cluster = screen
      .getAllByRole('link')
      .map((l) => l.getAttribute('aria-label') ?? l.textContent)
      .filter((name) => name === 'Settings' || name === 'Help' || name === 'Send feedback');
    expect(cluster).toEqual(['Settings', 'Help', 'Send feedback']);
  });
});
