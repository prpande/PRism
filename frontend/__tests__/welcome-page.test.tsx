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

  it('renders Help and Send feedback as plain text stubs, not links', () => {
    renderWelcome();
    expect(screen.getByText('Help')).toBeInTheDocument();
    expect(screen.getByText('Send feedback')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^help$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /send feedback/i })).toBeNull();
    expect(screen.getByText('Help').tagName).toBe('SPAN');
  });
});
