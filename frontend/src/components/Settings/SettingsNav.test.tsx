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
});
