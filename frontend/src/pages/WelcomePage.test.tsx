import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { WelcomePage } from './WelcomePage';

function renderWelcome() {
  return render(
    <MemoryRouter>
      <WelcomePage />
    </MemoryRouter>,
  );
}

describe('WelcomePage', () => {
  it('renders the PRism wordmark as an h1', () => {
    renderWelcome();
    expect(screen.getByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
  });

  it('renders a "Get started" link to /setup', () => {
    renderWelcome();
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/setup');
  });

  it('renders Help as a link to /help', () => {
    renderWelcome();
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
  });

  it('renders Send feedback as an inert stub (not a link)', () => {
    renderWelcome();
    expect(screen.queryByRole('link', { name: /send feedback/i })).toBeNull();
    expect(screen.getByText('Send feedback')).toBeInTheDocument();
  });
});
