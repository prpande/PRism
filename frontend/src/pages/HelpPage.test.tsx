import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { HelpPage } from './HelpPage';

function renderHelp() {
  return render(
    <MemoryRouter>
      <HelpPage />
    </MemoryRouter>,
  );
}

describe('HelpPage', () => {
  it('renders an h1 "Help" and the main landmark', () => {
    renderHelp();
    expect(screen.getByRole('heading', { level: 1, name: 'Help' })).toBeInTheDocument();
    expect(screen.getByTestId('help-page')).toBeInTheDocument();
  });

  it('has scannable h2 sections with stable ids', () => {
    renderHelp();
    for (const id of ['what-is-prism', 'core-workflow', 'surfaces', 'connect-token', 'shortcuts']) {
      // eslint-disable-next-line testing-library/no-node-access
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it('refers to a GitHub token, never Azure DevOps', () => {
    renderHelp();
    expect(screen.getByTestId('help-page').textContent).toMatch(/GitHub/);
    expect(screen.getByTestId('help-page').textContent).not.toMatch(/Azure DevOps/i);
  });

  it('links token guidance to the GitHub-connection settings', () => {
    renderHelp();
    expect(screen.getByRole('link', { name: /github connection/i })).toHaveAttribute(
      'href',
      '/settings/github-connection',
    );
  });
});
