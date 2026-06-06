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
