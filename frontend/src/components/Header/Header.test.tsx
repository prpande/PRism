import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { Header } from './Header';

function at(path: string, isAuthed = true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header isAuthed={isAuthed} />
    </MemoryRouter>,
  );
}

describe('Header gear', () => {
  it('renders a Settings gear link to /settings/appearance when authed', () => {
    at('/');
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      '/settings/appearance',
    );
  });

  it('marks the gear active while a settings modal is open', () => {
    at('/settings/system');
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps Inbox as a tab', () => {
    at('/');
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('does not render the gear first-run (unauthed)', () => {
    at('/setup', false);
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  });
});

describe('Header help', () => {
  it('renders a Help link to /help when authed', () => {
    at('/');
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
  });

  it('marks the Help link active on /help', () => {
    at('/help');
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides the Help link when not authed', () => {
    at('/', false);
    expect(screen.queryByRole('link', { name: 'Help' })).toBeNull();
  });
});

describe('Header feedback', () => {
  // Query by role=link: on /feedback the modal's dialog + submit button also carry a
  // "send feedback" accessible name, so a bare /feedback/i text query would be ambiguous.
  it('renders a Send feedback link to /feedback when authed', () => {
    at('/');
    expect(screen.getByRole('link', { name: /send feedback/i })).toHaveAttribute(
      'href',
      '/feedback',
    );
  });

  it('marks the Feedback link active on /feedback', () => {
    at('/feedback');
    expect(screen.getByRole('link', { name: /send feedback/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('hides the Feedback link when not authed', () => {
    at('/', false);
    expect(screen.queryByRole('link', { name: /send feedback/i })).toBeNull();
  });

  it('orders the right-side cluster Settings · Help · Feedback', () => {
    at('/');
    const cluster = screen
      .getAllByRole('link')
      .map((l) => l.getAttribute('aria-label') ?? l.textContent)
      .filter((name) => name === 'Settings' || name === 'Help' || name === 'Send feedback');
    expect(cluster).toEqual(['Settings', 'Help', 'Send feedback']);
  });
});
