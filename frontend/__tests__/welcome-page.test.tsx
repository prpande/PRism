import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { WelcomePage } from '../src/pages/WelcomePage';

function renderWelcome() {
  return render(
    <MemoryRouter>
      <WelcomePage />
    </MemoryRouter>,
  );
}

describe('WelcomePage', () => {
  it('renders the brand icon decoratively (empty alt)', () => {
    const { container } = renderWelcome();
    const img = container.querySelector('img[src="/prism-logo.png"]');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('alt', '');
  });

  it('renders the PRism wordmark as the h1', () => {
    renderWelcome();
    expect(screen.getByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
  });

  it('renders the tagline and three benefit rows', () => {
    renderWelcome();
    expect(
      screen.getByText(/review pull requests without leaving your machine/i),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('Get started links to /setup', () => {
    renderWelcome();
    const cta = screen.getByRole('link', { name: /get started/i });
    expect(cta).toHaveAttribute('href', '/setup');
  });

  // #210 wired the Help footer entry to the /help route. Send feedback stays an
  // inert stub until #211 (PR2) wires it.
  it('renders Help as a /help link and Send feedback as a plain text stub', () => {
    renderWelcome();
    expect(screen.getByRole('link', { name: /^help$/i })).toHaveAttribute('href', '/help');
    expect(screen.getByText('Send feedback')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /send feedback/i })).toBeNull();
    expect(screen.getByText('Send feedback').tagName).toBe('SPAN');
  });
});
