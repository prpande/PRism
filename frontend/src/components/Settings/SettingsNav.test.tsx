import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { SettingsNav } from './SettingsNav';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsNav />
    </MemoryRouter>,
  );
}

describe('SettingsNav', () => {
  it('renders the primary items and the System group', () => {
    renderAt('/settings/appearance');
    expect(screen.getByRole('link', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GitHub Connection' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Files & logs' })).toBeInTheDocument();
  });

  it('marks the active section with aria-current=page', () => {
    renderAt('/settings/github-connection');
    expect(screen.getByRole('link', { name: 'GitHub Connection' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Appearance' })).not.toHaveAttribute('aria-current');
  });

  it('shows the AI marker only on the AI nav item', () => {
    renderAt('/settings/appearance');
    const aiLink = screen.getByRole('link', { name: /^AI/ });
    expect(aiLink.querySelector('[data-ai-marker]')).not.toBeNull();
    const appearance = screen.getByRole('link', { name: 'Appearance' });
    expect(appearance.querySelector('[data-ai-marker]')).toBeNull();
  });
});

describe('SettingsNav AI nesting', () => {
  it('shows AI children only when an /settings/ai* route is active', () => {
    renderAt('/settings/appearance');
    expect(screen.queryByRole('link', { name: 'Usage' })).not.toBeInTheDocument();

    renderAt('/settings/ai');
    expect(screen.getByRole('link', { name: 'Configuration' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Usage' })).toBeInTheDocument();
  });

  it('marks Usage as current when on /settings/ai/usage', () => {
    renderAt('/settings/ai/usage');
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');
    // The AI parent reflects the active section too.
    expect(screen.getByRole('link', { name: /^AI/ })).toHaveAttribute('aria-current', 'page');
  });
});
