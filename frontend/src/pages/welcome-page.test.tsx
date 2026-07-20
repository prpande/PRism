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
    expect(screen.getByText(/a calmer place to review pull requests/i)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('Get started links to /setup', () => {
    renderWelcome();
    const cta = screen.getByRole('link', { name: /get started/i });
    expect(cta).toHaveAttribute('href', '/setup');
  });

  // #210 wired Help; #211 wired Send feedback.
  it('renders Help as a /help link and Send feedback as a /feedback link', () => {
    renderWelcome();
    expect(screen.getByRole('link', { name: /^help$/i })).toHaveAttribute('href', '/help');
    const feedbackLink = screen.getByRole('link', { name: /send feedback/i });
    expect(feedbackLink).toHaveAttribute('href', '/feedback');
  });
});
